import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  getTrinityDesktopBridge,
  type TrinityDesktopBridge,
} from '../platform/trinity-desktop-bridge';

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
 * via the `trinityDesktop.secureStore` bridge (the renderer never touches the keyring
 * or the on-disk ciphertext directly).
 */
function createElectronBackend(
  store: NonNullable<TrinityDesktopBridge['secureStore']>,
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

  private resolve(): Promise<SecureStorageBackend> {
    return (this.backend ??= this.select());
  }

  private async select(): Promise<SecureStorageBackend> {
    // 1) Electron desktop — safeStorage via the trinityDesktop IPC bridge.
    const bridge = getTrinityDesktopBridge();
    if (bridge?.secureStore && (await bridge.secureStore.isAvailable())) {
      return createElectronBackend(bridge.secureStore);
    }
    // 2) TODO(native): a Keychain/Keystore backend (@aparajita/capacitor-secure-storage)
    //    once the iOS/Android projects are scaffolded (`cap add` → `cap sync` → native
    //    rebuild; Android minSdk 23+, allowBackup=false). Until then native devices use
    //    the best-effort web fallback below.
    // 3) Web/PWA (and Electron without an available keyring).
    return createWebBackend();
  }
}
