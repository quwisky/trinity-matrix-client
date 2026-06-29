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

/** 0600: readable/writable only by the owning user (the on-disk ciphertext map). */
const STORE_FILE_MODE = 0o600;

/**
 * Injectable file access so tests never touch disk. The defaults read/write the
 * store file synchronously via `node:fs`, mirroring the original main-process code.
 */
export interface SecureStoreIo {
  /** Read the store file as UTF-8 text. Throws (e.g. ENOENT) when it is absent. */
  readFile: (filePath: string) => string;
  /** Persist the store file as UTF-8 text (created/truncated with mode 0600). */
  writeFile: (filePath: string, data: string) => void;
}

const defaultIo: SecureStoreIo = {
  readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
  writeFile: (filePath, data) =>
    fs.writeFileSync(filePath, data, { mode: STORE_FILE_MODE }),
};

/**
 * Read + parse the on-disk secret map. Returns an empty map for a missing file,
 * non-JSON garbage, or a non-object payload — never throws.
 */
export function readSecureStore(
  filePath: string,
  io: SecureStoreIo = defaultIo,
): Record<string, string> {
  try {
    const raw = JSON.parse(io.readFile(filePath)) as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Persist the secret map as JSON. */
export function writeSecureStore(
  filePath: string,
  data: Record<string, string>,
  io: SecureStoreIo = defaultIo,
): void {
  io.writeFile(filePath, JSON.stringify(data));
}

/**
 * Decrypt and return the value for `key`, or `null` when it is absent, when OS
 * encryption is unavailable, or when decryption fails. Never throws.
 */
export function secureStoreGet(
  safeStorage: SafeStorage,
  filePath: string,
  key: string,
  io: SecureStoreIo = defaultIo,
): string | null {
  const entry = readSecureStore(filePath, io)[key];
  if (!entry || !safeStorage.isEncryptionAvailable()) {
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
 * when OS encryption is unavailable, so the renderer can fall back; `true` on
 * success.
 */
export function secureStoreSet(
  safeStorage: SafeStorage,
  filePath: string,
  key: string,
  value: string,
  io: SecureStoreIo = defaultIo,
): boolean {
  if (!safeStorage.isEncryptionAvailable()) {
    return false;
  }
  const data = readSecureStore(filePath, io);
  data[key] = safeStorage.encryptString(value).toString('base64');
  writeSecureStore(filePath, data, io);
  return true;
}

/**
 * Remove `key` from the store (persisting the rest). No-op when it is absent.
 * Needs no `safeStorage` — deletion never touches the OS keyring.
 */
export function secureStoreDelete(
  filePath: string,
  key: string,
  io: SecureStoreIo = defaultIo,
): void {
  const data = readSecureStore(filePath, io);
  if (key in data) {
    delete data[key];
    writeSecureStore(filePath, data, io);
  }
}
