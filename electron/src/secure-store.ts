/**
 * OS-encrypted secret store backing the `trinity:secure-store:*` IPC handlers.
 *
 * Pure, dependency-injected logic: every function takes the Electron
 * `safeStorage` object and the on-disk store path as parameters, plus an
 * optional {@link SecureStoreIo} for file access (defaults to `node:fs`). The
 * only `electron` reference is an `import type`, which is erased at compile
 * time — so this module has NO runtime dependency on `electron` and is unit
 * testable in plain node without touching disk.
 *
 * `safeStorage` encrypts only bytes, so values are stored as a JSON map of
 * `key -> base64(ciphertext)` in a single 0600 file under `userData`.
 */
import * as fs from 'node:fs';
import type { SafeStorage } from 'electron';

/**
 * Whether safeStorage will give us REAL encryption — not merely whether it will accept
 * a string.
 *
 * On Linux, when no OS password manager can be determined, Electron selects the
 * `basic_text` backend, which "encrypts" with a hardcoded key. That is obfuscation, not
 * encryption: anything running as the user recovers the Matrix access token and the
 * crypto-store key, and with that key the store holding the cross-signing keys.
 * `isEncryptionAvailable()` does NOT distinguish it, so a token would be stored under a
 * false promise while `isSecure()` reported true.
 *
 * Refusing it means the renderer takes its documented plaintext fallback and surfaces
 * the anomaly, rather than us silently pretending the secret is protected.
 */
export function secureStorageUsable(safeStorage: SafeStorage): boolean {
  if (!safeStorage.isEncryptionAvailable()) {
    return false;
  }
  if (process.platform !== 'linux') {
    return true;
  }
  // Guarded: getSelectedStorageBackend is Linux-only and absent on older Electron.
  const backend = safeStorage.getSelectedStorageBackend?.();
  return backend !== 'basic_text' && backend !== 'unknown';
}

/** 0600: readable/writable only by the owning user (the on-disk ciphertext map). */
const STORE_FILE_MODE = 0o600;

/**
 * Injectable file access so tests never touch disk. The defaults read/write the
 * store file synchronously via `node:fs`, mirroring the original main-process code.
 */
export interface SecureStoreIo {
  /** Read the store file as UTF-8 text. Throws (e.g. ENOENT) when it is absent. */
  readFile: (filePath: string) => string;
  /** Persist the store file as UTF-8 text, replacing it whole (mode 0600). */
  writeFile: (filePath: string, data: string) => void;
  /** Rename a file (used to move an unparseable store file aside). */
  renameFile: (from: string, to: string) => void;
}

const defaultIo: SecureStoreIo = {
  readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
  writeFile: (filePath, data) => atomicWriteFile(filePath, data),
  renameFile: (from, to) => fs.renameSync(from, to),
};

/**
 * Replace `filePath` with `data` so that a crash or a failed write leaves either the old
 * file or the new one, never a truncated mix: write a 0600 temp file in the same
 * directory, flush it to disk, then rename it over the original.
 */
export function atomicWriteFile(
  filePath: string,
  data: string,
  fsImpl: typeof fs = fs,
): void {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fsImpl.openSync(temp, 'wx', STORE_FILE_MODE);
  try {
    try {
      const bytes = Buffer.from(data, 'utf8');
      for (let at = 0; at < bytes.length;) {
        at += fsImpl.writeSync(fd, bytes, at);
      }
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
    fsImpl.renameSync(temp, filePath);
  } catch (error) {
    fsImpl.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Read + parse the on-disk secret map. Returns an empty map for a missing file,
 * non-JSON garbage, or a non-object payload — never throws.
 */
function readSecureStore(
  filePath: string,
  io: SecureStoreIo = defaultIo,
): Record<string, string> {
  try {
    const raw = JSON.parse(io.readFile(filePath)) as unknown;
    return raw && typeof raw === 'object'
      ? (raw as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/**
 * What the store file holds, for a read that must not mistake a broken store for an
 * empty one. A missing or empty file is an empty map. Any other read error is
 * `unreadable`: the entries may be there but cannot be read right now. Content that is
 * not a JSON map is `corrupt`: no later read will do better.
 */
type StoreFile =
  | { readonly kind: 'ok'; readonly data: Record<string, string> }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'corrupt' };

function readStoreFile(filePath: string, io: SecureStoreIo): StoreFile {
  let text: string;
  try {
    text = io.readFile(filePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'ok', data: {} }
      : { kind: 'unreadable' };
  }
  if (text.trim() === '') {
    return { kind: 'ok', data: {} };
  }
  try {
    const raw = JSON.parse(text) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { kind: 'ok', data: raw as Record<string, string> }
      : { kind: 'corrupt' };
  } catch {
    return { kind: 'corrupt' };
  }
}

/** The secret map, or null when the store file is unreadable or corrupt. */
function readSecureStoreStrict(
  filePath: string,
  io: SecureStoreIo,
): Record<string, string> | null {
  const file = readStoreFile(filePath, io);
  return file.kind === 'ok' ? file.data : null;
}

/** Persist the secret map as JSON. */
function writeSecureStore(
  filePath: string,
  data: Record<string, string>,
  io: SecureStoreIo = defaultIo,
): void {
  io.writeFile(filePath, JSON.stringify(data));
}

/**
 * What reading one secret found. `unavailable` is not `absent`: the entry exists but OS
 * encryption cannot open it right now (a keyring not unlocked yet, a denied keychain).
 * Callers must not treat it as a lost secret.
 */
export type SecureStoreRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'present'; readonly value: string };

/**
 * Read `key` without collapsing "no entry" into "cannot decrypt it now". A decrypt failure
 * also counts as unavailable: Electron gives no reason, so a locked keyring cannot be told
 * from a replaced one, and only the former is worth waiting for. Never throws.
 */
export function secureStoreRead(
  safeStorage: SafeStorage,
  filePath: string,
  key: string,
  io: SecureStoreIo = defaultIo,
): SecureStoreRead {
  const store = readSecureStoreStrict(filePath, io);
  if (store === null) {
    return { kind: 'unavailable' };
  }
  const entry = store[key];
  if (!entry) {
    return { kind: 'absent' };
  }
  if (!secureStorageUsable(safeStorage)) {
    return { kind: 'unavailable' };
  }
  try {
    return {
      kind: 'present',
      value: safeStorage.decryptString(Buffer.from(entry, 'base64')),
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * Decrypt and return the value for `key`, or `null` when it is absent, when OS
 * encryption is unavailable, or when decryption fails. Never throws. Use
 * {@link secureStoreRead} where "absent" and "unavailable" must not be confused.
 */
export function secureStoreGet(
  safeStorage: SafeStorage,
  filePath: string,
  key: string,
  io: SecureStoreIo = defaultIo,
): string | null {
  const entry = readSecureStore(filePath, io)[key];
  if (!entry || !secureStorageUsable(safeStorage)) {
    return null;
  }
  try {
    return safeStorage.decryptString(Buffer.from(entry, 'base64'));
  } catch {
    return null;
  }
}

/**
 * Encrypt and persist `value` under `key`. Returns `false` (writing nothing)
 * when OS encryption is unavailable, or when the store file cannot be read right now
 * (writing then would drop every other entry), so the renderer can fall back; `true` on
 * success. A file that is not a JSON map is moved aside first (see {@link readStoreFile}).
 */
export function secureStoreSet(
  safeStorage: SafeStorage,
  filePath: string,
  key: string,
  value: string,
  io: SecureStoreIo = defaultIo,
): boolean {
  if (!secureStorageUsable(safeStorage)) {
    return false;
  }
  const file = readStoreFile(filePath, io);
  if (file.kind === 'unreadable') {
    return false;
  }
  let data: Record<string, string> = {};
  if (file.kind === 'corrupt') {
    // Nothing in it can be read, now or later, and refusing every write would block
    // sign-in for good. Keep it for inspection and start again from an empty store.
    const aside = `${filePath}.corrupt-${Date.now()}`;
    try {
      io.renameFile(filePath, aside);
    } catch {
      return false;
    }
    console.warn('[secure-store] moved an unparseable store file aside', aside);
  } else {
    data = { ...file.data };
  }
  data[key] = safeStorage.encryptString(value).toString('base64');
  writeSecureStore(filePath, data, io);
  return true;
}

/**
 * Remove `key` from the store (persisting the rest). No-op when it is absent.
 * Needs no `safeStorage` — deletion never touches the OS keyring. Returns `false`,
 * writing nothing, when the store file cannot be read right now; `true` otherwise.
 */
export function secureStoreDelete(
  filePath: string,
  key: string,
  io: SecureStoreIo = defaultIo,
): boolean {
  const data = readSecureStoreStrict(filePath, io);
  if (data === null) {
    console.warn(
      '[secure-store] could not read the store file; nothing deleted',
    );
    return false;
  }
  if (key in data) {
    delete data[key];
    writeSecureStore(filePath, data, io);
  }
  return true;
}
