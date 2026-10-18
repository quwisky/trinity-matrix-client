import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import {
  KeychainAccess,
  SecureStorage,
} from '@aparajita/capacitor-secure-storage';
import {
  getTrinityDesktopBridge,
  type TrinityDesktopBridge,
} from './trinity-desktop-bridge';
import { STORE_KEY_PREFIX, toBase64, unwrap } from './crypto-store-key-format';
import {
  deleteWrappingKey,
  loadWrappingKey,
} from './crypto-store-wrapping-keys';

/**
 * What reading one secret found. `unavailable` is not `absent`: the backend may hold the
 * entry but cannot open it right now (a locked keyring, a denied keychain, a desktop that
 * fell back to web storage this session). Never treat it as a lost secret.
 */
export type SecureStorageRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'present'; readonly value: string };

/** What this device's person was told about secrets stored without a keychain. */
export type UnprotectedStorageAcknowledgement = 'consented' | 'notified';

const UNPROTECTED_ACK_KEY = 'trinity.secure-storage.unprotected';

const ABSENT: SecureStorageRead = { kind: 'absent' };
const UNAVAILABLE: SecureStorageRead = { kind: 'unavailable' };

/**
 * One secret-storage backend. `isSecure` is true only when values are held behind an
 * OS keychain/keystore (Electron `safeStorage`, native Keychain/Keystore); it is false
 * for the web fallback, where no XSS-proof storage exists.
 */
export interface SecureStorageBackend {
  readonly kind: 'electron' | 'native' | 'web';
  readonly isSecure: boolean;
  /** The web store standing in for a keychain this host has but could not use. */
  readonly withoutKeychain: boolean;
  get(key: string): Promise<string | null>;
  read(key: string): Promise<SecureStorageRead>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /**
   * Drop every secret this backend holds. Optional because only the native plugin offers
   * it: Electron's IPC bridge exposes per-key deletion only, and the web fallback's keys
   * live in Preferences, which the factory reset clears as a group. A backend without it
   * relies on the caller deleting keys derived from the account registry.
   */
  clear?(): Promise<void>;
}

/** Namespace the web fallback's keys so they don't collide with other Preferences. */
const WEB_PREFIX = 'secure.';

/**
 * Web/PWA fallback. A browser has no XSS-proof secret store, so this is best-effort
 * Capacitor Preferences (localStorage on web); `isSecure` is false. The real web
 * defenses are the CSP (`script-src 'self'`, no inline) plus DOMPurify sanitization.
 *
 * `degraded` marks the fallback on a host that has a keychain it could not reach: a secret
 * missing here may still sit in that keychain, so it reads as unavailable, not absent.
 */
function createWebBackend(degraded = false): SecureStorageBackend {
  const get = async (key: string): Promise<string | null> =>
    (await Preferences.get({ key: WEB_PREFIX + key })).value ?? null;
  return {
    kind: 'web',
    isSecure: false,
    withoutKeychain: degraded,
    get,
    async read(key) {
      const value = await get(key);
      if (value !== null) return { kind: 'present', value };
      return degraded ? UNAVAILABLE : ABSENT;
    },
    async set(key, value) {
      await Preferences.set({ key: WEB_PREFIX + key, value });
    },
    async remove(key) {
      await Preferences.remove({ key: WEB_PREFIX + key });
    },
  };
}

/**
 * Electron desktop: OS-keychain-backed `safeStorage`, reached through the main process;
 * the renderer never touches the keyring or the on-disk ciphertext directly.
 */
function createElectronBackend(
  store: TrinityDesktopBridge['capabilities']['secureStore'],
): SecureStorageBackend {
  return {
    kind: 'electron',
    isSecure: true,
    withoutKeychain: false,
    get: (key) => store.get(key),
    async read(key) {
      if (!store.read) {
        // That shell's get also returns null for an entry it cannot decrypt, so null
        // cannot be taken as absent here.
        const value = await store.get(key);
        return value === null ? UNAVAILABLE : { kind: 'present', value };
      }
      return parseRead(await store.read(key));
    },
    async set(key, value) {
      if (!(await store.set(key, value))) {
        throw new Error('secure-store: the OS keychain is unavailable');
      }
    },
    remove: (key) => store.delete(key),
  };
}

/**
 * Native iOS/Android: the OS Keychain / Android Keystore via
 * `@aparajita/capacitor-secure-storage`. Every value belongs to this device's Matrix
 * session, so it stays on this device: `sync: false` keeps it out of iCloud Keychain, and
 * the iOS `whenUnlockedThisDeviceOnly` class keeps a backup restored onto another device
 * from bringing it along. The iOS app moves an item written before this class was set
 * to it at launch (`AppDelegate.keepStoredDataOnThisDevice`).
 */
function createNativeBackend(): SecureStorageBackend {
  return {
    kind: 'native',
    isSecure: true,
    withoutKeychain: false,
    async get(key) {
      const value = await SecureStorage.get(key, false, false);
      return typeof value === 'string' ? value : null;
    },
    async read(key) {
      try {
        const value = await SecureStorage.get(key, false, false);
        return typeof value === 'string' ? { kind: 'present', value } : ABSENT;
      } catch {
        // The keychain refused (device locked, keystore error): not a missing entry.
        return UNAVAILABLE;
      }
    },
    async set(key, value) {
      await SecureStorage.set(
        key,
        value,
        false,
        false,
        KeychainAccess.whenUnlockedThisDeviceOnly,
      );
    },
    async remove(key) {
      await SecureStorage.remove(key, false);
    },
    async clear() {
      // Scoped to this app's keychain/keystore prefix, not the device's.
      await SecureStorage.clear(false);
    },
  };
}

/**
 * Stores secrets (notably the Matrix access token) behind the strongest backend the
 * current platform offers, chosen once at first use and memoized.
 */
@Injectable({ providedIn: 'root' })
export class SecureStorageService {
  private backend?: Promise<SecureStorageBackend>;

  get(key: string): Promise<string | null> {
    return this.resolve().then((b) => b.get(key));
  }

  /**
   * Read one secret as absent, unavailable or present. Any failure, including a backend
   * that cannot be selected yet, is unavailable: only a backend that looked and found no
   * entry says absent.
   */
  async read(key: string): Promise<SecureStorageRead> {
    try {
      return await (await this.resolve()).read(key);
    } catch {
      return UNAVAILABLE;
    }
  }

  set(key: string, value: string): Promise<void> {
    return this.resolve().then((b) => b.set(key, value));
  }

  remove(key: string): Promise<void> {
    return this.resolve().then((b) => b.remove(key));
  }

  /** Whether the chosen backend is keychain/keystore-backed (false on web). */
  async isSecure(): Promise<boolean> {
    return (await this.resolve()).isSecure;
  }

  /**
   * Whether secrets written now would land unprotected on disk because this host's keychain
   * could not be used (an Electron desktop without a usable keyring). The signal for the
   * sign-in consent; false on the web, where no keychain exists.
   */
  async withoutKeychain(): Promise<boolean> {
    return (await this.resolve()).withoutKeychain;
  }

  /**
   * Whether secrets actually sit unprotected on disk on a host that has a keychain: the
   * signal for the Security settings warning and the one-time notice. Waits for backend
   * selection first, so a keychain that came back has taken in any leftovers.
   */
  async storesUnprotectedSecrets(): Promise<boolean> {
    if (!getTrinityDesktopBridge() && !Capacitor.isNativePlatform()) {
      return false;
    }
    await this.resolve().catch(() => undefined);
    const { keys } = await Preferences.keys();
    return keys.some((key) => key.startsWith(WEB_PREFIX));
  }

  /** Whether this device's person agreed to, or was told about, storing without a keychain. */
  async unprotectedStorageAcknowledged(): Promise<UnprotectedStorageAcknowledgement | null> {
    const { value } = await Preferences.get({ key: UNPROTECTED_ACK_KEY });
    return value === 'consented' || value === 'notified' ? value : null;
  }

  acknowledgeUnprotectedStorage(
    acknowledgement: UnprotectedStorageAcknowledgement,
  ): Promise<void> {
    return Preferences.set({
      key: UNPROTECTED_ACK_KEY,
      value: acknowledgement,
    });
  }

  /**
   * Best-effort bulk wipe. Resolves `true` only when the backend actually swept itself;
   * only the native keychain/keystore backend can.
   *
   * This is NOT how the factory reset clears secrets. It removes each account's keys by
   * name first (`SessionStorageService.clearAll`), which covers Electron (no bulk clear)
   * and web (keys live in Preferences). Skipping that pass would leave Electron's
   * main-process store populated AND unreachable, because the registry naming its keys is
   * deleted moments later. This adds, on native, the residue that pass cannot reach: a
   * secret whose account is no longer listed and whose key nothing can name.
   */
  async clearAll(): Promise<boolean> {
    const backend = await this.resolve();
    if (!backend.clear) {
      return false;
    }
    try {
      await backend.clear();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The chosen backend, selected once. A REJECTED selection must not be memoized, or every
   * later call would reject for the page lifetime. The reachable case is a desktop startup
   * race: `createWindow()` loads the renderer before `registerSecureStoreIpc()` is
   * installed, so the availability probe can reject with nothing wrong with the keychain.
   * Clearing the memo makes the next call retry.
   *
   * Deliberately NOT swallowed into the web fallback: on a device that has a keychain, a
   * transient IPC failure would latch a plaintext token store for the whole session.
   */
  private resolve(): Promise<SecureStorageBackend> {
    return (this.backend ??= this.select().catch((err: unknown) => {
      this.backend = undefined;
      throw err;
    }));
  }

  private async select(): Promise<SecureStorageBackend> {
    const bridge = getTrinityDesktopBridge();
    const electronStore = bridge?.capabilities.secureStore;
    if (electronStore && (await electronStore.isAvailable())) {
      const backend = createElectronBackend(electronStore);
      await moveUnprotectedSecrets(backend);
      return backend;
    }
    if (
      Capacitor.isNativePlatform() &&
      Capacitor.isPluginAvailable('SecureStorage')
    ) {
      return createNativeBackend();
    }
    // Web/PWA fallback is plaintext. That is the norm on web (CSP + sanitization), but on
    // desktop/native it means the OS keychain FAILED and the access token will land in
    // plaintext: sign-in asks for consent first and Security settings warns
    // (`withoutKeychain`).
    const degraded = !!bridge || Capacitor.isNativePlatform();
    if (degraded) {
      console.warn(
        'Trinity: secure storage (OS keychain/keystore) is unavailable on this ' +
          'device — the session token will be stored unencrypted. Sign out to ' +
          'clear it, or investigate the keyring on this machine.',
      );
    }
    return createWebBackend(degraded);
  }
}

/**
 * Move secrets an earlier keyring-less launch left in the web store into the keychain that
 * is usable again. Each is deleted from the web store only after the keychain took it; one
 * that fails stays for the next launch. Which copy is newer cannot be told, so a value the
 * keychain already holds wins and the leftover beside it is dropped. A crypto store key was
 * saved wrapped for the web store, so it moves unwrapped, the form a keychain holds, and its
 * wrapping key goes too; one that can never be unwrapped is dropped.
 */
async function moveUnprotectedSecrets(
  into: SecureStorageBackend,
): Promise<void> {
  let keys: string[];
  try {
    keys = (await Preferences.keys()).keys.filter((key) =>
      key.startsWith(WEB_PREFIX),
    );
  } catch {
    return;
  }
  for (const webKey of keys) {
    const key = webKey.slice(WEB_PREFIX.length);
    const storePrefix = key.startsWith(STORE_KEY_PREFIX)
      ? key.slice(STORE_KEY_PREFIX.length)
      : null;
    const drop = async (): Promise<void> => {
      await Preferences.remove({ key: webKey });
      if (storePrefix !== null) {
        await deleteWrappingKey(storePrefix).catch(() => undefined);
      }
    };
    try {
      const { value } = await Preferences.get({ key: webKey });
      if (value === null) continue;
      const held = await into.read(key);
      if (held.kind === 'present') {
        await drop();
        continue;
      }
      if (held.kind === 'unavailable') continue;
      const moved =
        storePrefix === null ? value : await unwrapped(storePrefix, value);
      if (moved === null) {
        await drop();
        continue;
      }
      await into.set(key, moved);
      await drop();
    } catch {
      // Kept where it is; the next launch with a keychain tries again.
    }
  }
}

/**
 * The keychain form of a wrapped store key, or null when it can never be unwrapped (its
 * wrapping key is gone, or the key does not open it). An IndexedDB error throws: it may pass.
 */
async function unwrapped(
  storePrefix: string,
  wrapped: string,
): Promise<string | null> {
  const wrappingKey = await loadWrappingKey(storePrefix);
  if (!wrappingKey) return null;
  try {
    return toBase64(await unwrap(wrappingKey, wrapped));
  } catch {
    return null;
  }
}

/** Validate an untrusted desktop read reply; anything unexpected is unavailable. */
function parseRead(reply: unknown): SecureStorageRead {
  if (typeof reply === 'object' && reply !== null) {
    const { kind, value } = reply as { kind?: unknown; value?: unknown };
    if (kind === 'absent') return ABSENT;
    if (kind === 'present' && typeof value === 'string') {
      return { kind: 'present', value };
    }
  }
  return UNAVAILABLE;
}
