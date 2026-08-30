import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import {
  getTrinityDesktopBridge,
  type TrinityDesktopBridge,
} from './trinity-desktop-bridge';

/**
 * One secret-storage backend. `isSecure` is true only when values are held behind an
 * OS keychain/keystore (Electron `safeStorage`, native Keychain/Keystore); it is false
 * for the web fallback, where no XSS-proof storage exists.
 */
export interface SecureStorageBackend {
  readonly kind: 'electron' | 'native' | 'web';
  readonly isSecure: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /**
   * Drop every secret this backend holds, where it can. Optional because only the native
   * plugin offers it — Electron's IPC bridge exposes per-key deletion only, and the web
   * fallback needs none (its keys live in Preferences, which the factory reset clears as a
   * group). A backend without it relies on the caller deleting keys it derived from the
   * account registry.
   */
  clear?(): Promise<void>;
}

/** Namespace the web fallback's keys so they don't collide with other Preferences. */
const WEB_PREFIX = 'secure.';

/**
 * Web/PWA fallback. A browser has no XSS-proof secret store, so this is best-effort —
 * Capacitor Preferences (localStorage on web). `isSecure` is false to make that
 * explicit; the real web defenses are the CSP (`script-src 'self'`, no inline) plus
 * DOMPurify sanitization. Native + Electron use OS-backed backends instead.
 */
function createWebBackend(): SecureStorageBackend {
  return {
    kind: 'web',
    isSecure: false,
    async get(key) {
      return (await Preferences.get({ key: WEB_PREFIX + key })).value ?? null;
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
 * Electron desktop: OS-keychain-backed `safeStorage`, reached through the main process
 * via the grouped desktop secure-store capability (the renderer never touches the keyring
 * or the on-disk ciphertext directly).
 */
function createElectronBackend(
  store: TrinityDesktopBridge['capabilities']['secureStore'],
): SecureStorageBackend {
  return {
    kind: 'electron',
    isSecure: true,
    get: (key) => store.get(key),
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
 * `@aparajita/capacitor-secure-storage`. `sync: false` (the last arg on each call)
 * keeps the value on THIS device — never synced to iCloud Keychain — so a per-device
 * Matrix session can't leak across a user's devices.
 */
function createNativeBackend(): SecureStorageBackend {
  return {
    kind: 'native',
    isSecure: true,
    async get(key) {
      const value = await SecureStorage.get(key, false, false);
      return typeof value === 'string' ? value : null;
    },
    async set(key, value) {
      await SecureStorage.set(key, value, false, false);
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
 * current platform offers, chosen once at first use and memoized. Centralizes the
 * platform branch so callers never feature-detect themselves.
 *
 * Backends are async (IPC / native plugin / browser storage), so the API is
 * promise-based; callers that expose Observables wrap with `from(...)`.
 */
@Injectable({ providedIn: 'root' })
export class SecureStorageService {
  private backend?: Promise<SecureStorageBackend>;

  get(key: string): Promise<string | null> {
    return this.resolve().then((b) => b.get(key));
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
   * Best-effort bulk wipe. Resolves `true` only when the backend actually swept itself —
   * only the native keychain/keystore backend can.
   *
   * This is NOT how the factory reset clears secrets. It removes each account's keys by
   * name first (`SessionStorageService.clearAll`), which is what covers Electron, whose
   * bridge exposes no bulk clear, and web, whose keys live in Preferences. Losing that
   * per-key pass would leave Electron's main-process store fully populated AND unreachable,
   * because the registry naming its keys is deleted moments later.
   *
   * What this adds on native is the residue that pass cannot reach: a secret orphaned by an
   * earlier bug, whose account is no longer listed and whose key nothing can name.
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
   * The chosen backend, selected once. A REJECTED selection must not be memoized: a
   * rejection is a value like any other, so caching it would make every later get/set/remove
   * reject for the page lifetime. The reachable case is a startup race on desktop —
   * `createWindow()` loads the renderer before `registerSecureStoreIpc()` is installed, so
   * the availability probe can reject with nothing wrong with the keychain at all. Clearing
   * the memo makes the next call retry (mirroring TrinityOidcTokenRefresher).
   *
   * Deliberately NOT swallowed into the web fallback: on a device that has a keychain, a
   * transient IPC failure would then latch a plaintext token store for the whole session.
   * A retryable rejection is the safer of the two.
   */
  private resolve(): Promise<SecureStorageBackend> {
    return (this.backend ??= this.select().catch((err: unknown) => {
      this.backend = undefined;
      throw err;
    }));
  }

  private async select(): Promise<SecureStorageBackend> {
    // 1) Electron desktop — safeStorage via the trinityDesktop IPC bridge.
    const bridge = getTrinityDesktopBridge();
    const electronStore = bridge?.capabilities.secureStore;
    if (electronStore && (await electronStore.isAvailable())) {
      return createElectronBackend(electronStore);
    }
    // 2) Native iOS/Android — OS Keychain / Android Keystore.
    if (
      Capacitor.isNativePlatform() &&
      Capacitor.isPluginAvailable('SecureStorage')
    ) {
      return createNativeBackend();
    }
    // 3) Web/PWA (and Electron/native without an available keyring): best-effort
    // plaintext. On web this is the documented norm (defended by CSP + sanitization),
    // but on desktop/native it means the OS keychain FAILED — secrets (the access
    // token) will land in plaintext. Surface that anomaly rather than falling back
    // silently. (A user-facing prompt is a further, product-owned step.)
    if (bridge || Capacitor.isNativePlatform()) {
      console.warn(
        'Trinity: secure storage (OS keychain/keystore) is unavailable on this ' +
          'device — the session token will be stored unencrypted. Sign out to ' +
          'clear it, or investigate the keyring on this machine.',
      );
    }
    return createWebBackend();
  }
}
