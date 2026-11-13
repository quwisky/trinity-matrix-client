import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_CAPABILITY_NEGOTIATOR,
  HostCapabilitiesService,
  type HostCapabilityManifest,
  type HostCapabilityNegotiator,
  unavailableHostManifest,
} from '@trinity/runtime/host';
import { NEVER, Subject, firstValueFrom, of } from 'rxjs';
import { SecureStorageService } from './secure-storage.service';
import { desktopBridgeFixture } from '@trinity/testing';

// In-memory @capacitor/preferences + the native keychain plugin (hoisted so the
// vi.mock factories can see them).
const { prefs, nativeStore, nativeSet, wrappingKeys } = vi.hoisted(() => ({
  prefs: new Map<string, string>(),
  nativeStore: new Map<string, string>(),
  nativeSet: { calls: [] as unknown[][] },
  wrappingKeys: new Map<string, CryptoKey>(),
}));
// jsdom ships no IndexedDB; the web store keys' wrapping keys are held here.
vi.mock('./crypto-store-wrapping-keys', () => ({
  loadWrappingKey: async (id: string) => wrappingKeys.get(id),
  deleteWrappingKey: async (id: string) => {
    wrappingKeys.delete(id);
  },
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({
      value: prefs.get(key) ?? null,
    }),
    set: async ({ key, value }: { key: string; value: string }) => {
      prefs.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      prefs.delete(key);
    },
    keys: async () => ({ keys: [...prefs.keys()] }),
  },
}));
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  KeychainAccess: { whenUnlocked: 0, whenUnlockedThisDeviceOnly: 1 },
  SecureStorage: {
    get: async (key: string) => nativeStore.get(key) ?? null,
    set: async (key: string, value: string, ...options: unknown[]) => {
      nativeSet.calls.push([key, value, ...options]);
      nativeStore.set(key, value);
    },
    remove: async (key: string) => {
      nativeStore.delete(key);
      return true;
    },
    clear: async () => {
      nativeStore.clear();
    },
  },
}));

function deferredValue<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('SecureStorageService', () => {
  beforeEach(() => {
    prefs.clear();
    nativeStore.clear();
    wrappingKeys.clear();
    nativeSet.calls = [];
  });
  afterEach(() => vi.restoreAllMocks());

  function service(): SecureStorageService {
    TestBed.configureTestingModule({ providers: [SecureStorageService] });
    return TestBed.inject(SecureStorageService);
  }

  it('selects the non-secure web backend when no keychain is available', async () => {
    // jsdom: no trinityDesktop bridge and not a native platform → web fallback.
    expect(await service().isSecure()).toBe(false);
  });

  it('round-trips under a namespaced Preferences key, and removes', async () => {
    const s = service();
    await s.set('accessToken', 'tok');
    expect(await s.get('accessToken')).toBe('tok');
    expect(prefs.get('secure.accessToken')).toBe('tok'); // namespaced, no collision

    await s.remove('accessToken');
    expect(await s.get('accessToken')).toBeNull();
  });

  it('uses the native keychain backend on a native platform', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true);
    const s = service();

    expect(await s.isSecure()).toBe(true);
    await s.set('accessToken', 'tok');
    expect(nativeStore.get('accessToken')).toBe('tok'); // keychain, not Preferences
    expect(prefs.get('secure.accessToken')).toBeUndefined();
    expect(await s.get('accessToken')).toBe('tok');

    await s.remove('accessToken');
    expect(await s.get('accessToken')).toBeNull();
  });

  it('keeps native secrets on this device: never synced, never restored to another one', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true);

    await service().set('matrix.cryptoStoreKey:@me:hs', 'key');

    // convertDate=false, sync=false (no iCloud Keychain), and an iOS accessibility class
    // that a backup restored onto another device does not bring along.
    expect(nativeSet.calls).toEqual([
      ['matrix.cryptoStoreKey:@me:hs', 'key', false, false, 1],
    ]);
  });

  describe('read', () => {
    /** Install a desktop bridge whose keychain is available and whose read returns `reply`. */
    function desktopReading(reply: unknown, available = true): void {
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
        desktopBridgeFixture({
          capabilities: {
            secureStore: {
              isAvailable: vi.fn().mockResolvedValue(available),
              get: vi.fn().mockResolvedValue(null),
              read: vi.fn().mockResolvedValue(reply),
              set: vi.fn().mockResolvedValue(true),
              delete: vi.fn().mockResolvedValue(undefined),
            } as never,
          },
        });
    }
    afterEach(() => {
      delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    });

    it.each([
      [
        { kind: 'present', value: 'v' },
        { kind: 'present', value: 'v' },
      ],
      [{ kind: 'absent' }, { kind: 'absent' }],
      [{ kind: 'unavailable' }, { kind: 'unavailable' }],
      // An untrusted reply that is not one of the three is never taken as absent.
      [{ kind: 'present' }, { kind: 'unavailable' }],
      [null, { kind: 'unavailable' }],
    ])(
      'passes the desktop keychain read %j through as %j',
      async (reply, read) => {
        desktopReading(reply);

        expect(await service().read('k')).toEqual(read);
      },
    );

    it('reads through get on a desktop shell without read, never claiming absent', async () => {
      const get = vi
        .fn()
        .mockResolvedValueOnce('v')
        .mockResolvedValueOnce(null);
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
        desktopBridgeFixture({
          capabilities: {
            secureStore: {
              isAvailable: vi.fn().mockResolvedValue(true),
              get,
              set: vi.fn().mockResolvedValue(true),
              delete: vi.fn().mockResolvedValue(undefined),
            },
          },
        });
      const s = service();

      expect(await s.read('k')).toEqual({ kind: 'present', value: 'v' });
      // Its get also returns null for an entry it cannot decrypt.
      expect(await s.read('k')).toEqual({ kind: 'unavailable' });
    });

    it('reads natively: an entry, no entry, or a keychain error as unavailable', async () => {
      vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
      vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true);
      const s = service();
      nativeStore.set('k', 'v');

      expect(await s.read('k')).toEqual({ kind: 'present', value: 'v' });
      expect(await s.read('missing')).toEqual({ kind: 'absent' });
      const { SecureStorage } =
        await import('@aparajita/capacitor-secure-storage');
      vi.spyOn(SecureStorage, 'get').mockRejectedValueOnce(
        new Error('errSecInteractionNotAllowed'),
      );
      expect(await s.read('k')).toEqual({ kind: 'unavailable' });
    });

    it('reads the plain web store: no entry is absent', async () => {
      const s = service();
      await s.set('k', 'v');

      expect(await s.read('k')).toEqual({ kind: 'present', value: 'v' });
      expect(await s.read('missing')).toEqual({ kind: 'absent' });
    });

    it('says unavailable, not absent, when a desktop keychain fell back to the web store', async () => {
      // The keychain may hold the entry; it just cannot be reached this session.
      desktopReading({ kind: 'present', value: 'v' }, false);

      expect(await service().read('missing')).toEqual({ kind: 'unavailable' });
    });

    it('says unavailable when no backend can be selected yet', async () => {
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
        desktopBridgeFixture({
          capabilities: {
            secureStore: {
              isAvailable: vi.fn().mockRejectedValue(new Error('no ipc yet')),
            } as never,
          },
        });

      expect(await service().read('k')).toEqual({ kind: 'unavailable' });
    });
  });

  describe('storing without a keychain', () => {
    function desktop(
      available: boolean,
      set: (key: string, value: string) => Promise<boolean> = async () => true,
      held: Record<string, string> = {},
    ) {
      const secureStore = {
        isAvailable: vi.fn().mockResolvedValue(available),
        set: vi.fn(set),
        read: vi.fn(async (key: string) =>
          key in held
            ? { kind: 'present', value: held[key] }
            : { kind: 'absent' },
        ),
      };
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
        desktopBridgeFixture({
          capabilities: { secureStore: secureStore as never },
        });
      return secureStore;
    }
    afterEach(() => {
      delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    });

    it('is reported only where a host keychain could not be used', async () => {
      expect(await service().withoutKeychain()).toBe(false);
      TestBed.resetTestingModule();

      desktop(true);
      expect(await service().withoutKeychain()).toBe(false);
      TestBed.resetTestingModule();

      desktop(false);
      const s = service();
      expect(await s.isSecure()).toBe(false);
      expect(await s.withoutKeychain()).toBe(true);
    });

    it('warns only about secrets that are actually stored unprotected', async () => {
      // Saved with a keyring, then a launch without one: nothing was written in plaintext.
      desktop(false);
      const s = service();
      expect(await s.withoutKeychain()).toBe(true);
      expect(await s.storesUnprotectedSecrets()).toBe(false);

      await s.set('matrix.accessToken:@me:hs', 'tok');
      expect(await s.storesUnprotectedSecrets()).toBe(true);
    });

    it('never reports the web store, where no keychain exists', async () => {
      const s = service();
      await s.set('matrix.accessToken:@me:hs', 'tok');
      expect(await s.storesUnprotectedSecrets()).toBe(false);
    });

    it('moves secrets left unprotected into the keychain once it is back', async () => {
      prefs.set('secure.matrix.accessToken:@me:hs', 'tok');
      const store = desktop(true);
      const s = service();

      expect(await s.storesUnprotectedSecrets()).toBe(false);
      expect(store.set).toHaveBeenCalledWith(
        'matrix.accessToken:@me:hs',
        'tok',
      );
      expect(prefs.has('secure.matrix.accessToken:@me:hs')).toBe(false);
    });

    it('stores a moved crypto store key unwrapped, as the keychain expects it', async () => {
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const wrappingKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, raw),
      );
      wrappingKeys.set('trinity-crypto:@me:hs:DEV', wrappingKey);
      prefs.set(
        'secure.matrix.cryptoStoreKey:trinity-crypto:@me:hs:DEV',
        btoa(String.fromCharCode(...iv, ...sealed)),
      );
      const store = desktop(true);

      await service().isSecure();

      expect(store.set).toHaveBeenCalledWith(
        'matrix.cryptoStoreKey:trinity-crypto:@me:hs:DEV',
        btoa(String.fromCharCode(...raw)),
      );
      expect(prefs.size).toBe(0);
      expect(wrappingKeys.size).toBe(0);
    });

    it('keeps the keychain’s own value and drops the leftover beside it', async () => {
      prefs.set('secure.matrix.accessToken:@me:hs', 'stale');
      const store = desktop(true, async () => true, {
        'matrix.accessToken:@me:hs': 'newer',
      });

      expect(await service().storesUnprotectedSecrets()).toBe(false);

      expect(store.set).not.toHaveBeenCalled();
      expect(prefs.size).toBe(0);
    });

    it('drops a wrapped store key whose wrapping key is gone, so no warning stays', async () => {
      prefs.set(
        'secure.matrix.cryptoStoreKey:trinity-crypto:@me:hs:DEV',
        btoa('not unwrappable'),
      );
      const store = desktop(true);

      expect(await service().storesUnprotectedSecrets()).toBe(false);

      expect(store.set).not.toHaveBeenCalled();
      expect(prefs.size).toBe(0);
    });

    it('keeps an unprotected secret the keychain would not take', async () => {
      prefs.set('secure.matrix.accessToken:@me:hs', 'tok');
      desktop(true, async () => false);

      await service().isSecure();

      expect(prefs.get('secure.matrix.accessToken:@me:hs')).toBe('tok');
    });

    it('remembers on this device that the person was told, or agreed', async () => {
      const s = service();
      expect(await s.unprotectedStorageAcknowledged()).toBeNull();

      await s.acknowledgeUnprotectedStorage('notified');
      expect(await s.unprotectedStorageAcknowledged()).toBe('notified');

      await s.acknowledgeUnprotectedStorage('consented');
      expect(await s.unprotectedStorageAcknowledged()).toBe('consented');

      prefs.set('trinity.secure-storage.unprotected', 'something else');
      expect(await s.unprotectedStorageAcknowledged()).toBeNull();
    });
  });

  it('retries backend selection after a rejected one, instead of latching it', async () => {
    // L3: the memo caches a promise, and a rejection is a value — so a probe that failed
    // once (on desktop, `createWindow()` loads the renderer before the secure-store IPC
    // handler is registered) used to reject every get/set for the whole page lifetime.
    const isAvailable = vi
      .fn()
      .mockRejectedValueOnce(new Error('no ipc handler yet'))
      .mockResolvedValue(true);
    const store = {
      isAvailable,
      get: vi.fn().mockResolvedValue('tok'),
      set: vi.fn().mockResolvedValue(true),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture({ capabilities: { secureStore: store } });
    try {
      const s = service();

      await expect(s.get('accessToken')).rejects.toThrow('no ipc handler yet');

      // The retry reaches the keychain the race denied the first call.
      expect(await s.get('accessToken')).toBe('tok');
      expect(await s.isSecure()).toBe(true);
      expect(isAvailable).toHaveBeenCalledTimes(2); // re-probed, not replayed
    } finally {
      delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    }
  });

  it('rejects instead of latching the unprotected store while the desktop negotiation is failing', async () => {
    // The preload answers "not available" for an ungranted store, as during a failed
    // negotiation; the keychain itself is fine and holds the token.
    let granted = false;
    const store = {
      isAvailable: vi.fn(async () => granted),
      get: vi.fn(async () => (granted ? 'tok' : null)),
      read: vi.fn(async () => ({ kind: 'absent' })),
      set: vi.fn(async () => granted),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture({ capabilities: { secureStore: store } });
    const negotiate = vi
      .fn(() => {
        granted = true;
        return of(unavailableHostManifest('not-supported'));
      })
      .mockReturnValueOnce(of(unavailableHostManifest('host-rejected')));
    TestBed.configureTestingModule({
      providers: [
        SecureStorageService,
        {
          provide: HOST_CAPABILITY_NEGOTIATOR,
          useValue: { manifest: negotiate },
        },
      ],
    });
    const host = TestBed.inject(HostCapabilitiesService);
    const s = TestBed.inject(SecureStorageService);
    try {
      await firstValueFrom(host.manifest());

      await expect(s.get('accessToken')).rejects.toThrow();
      await expect(s.set('accessToken', 'new')).rejects.toThrow();
      await expect(s.remove('accessToken')).rejects.toThrow();
      await expect(s.clearAll()).rejects.toThrow();
      expect(await s.read('accessToken')).toEqual({ kind: 'unavailable' });
      expect(prefs.size).toBe(0);

      await firstValueFrom(host.manifest());

      expect(await s.get('accessToken')).toBe('tok');
      expect(await s.isSecure()).toBe(true);
      expect(await s.withoutKeychain()).toBe(false);
    } finally {
      delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    }
  });

  describe('a desktop whose host negotiation has not succeeded', () => {
    afterEach(() => {
      delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    });

    function desktop(
      isAvailable: () => Promise<boolean>,
      manifest: HostCapabilityNegotiator['manifest'],
    ): { s: SecureStorageService; host: HostCapabilitiesService } {
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
        desktopBridgeFixture({
          capabilities: {
            secureStore: {
              isAvailable: vi.fn(isAvailable),
              get: vi.fn().mockResolvedValue('tok'),
              read: vi.fn(async () => ({ kind: 'absent' })),
              set: vi.fn().mockResolvedValue(true),
              delete: vi.fn().mockResolvedValue(undefined),
            },
          },
        });
      TestBed.configureTestingModule({
        providers: [
          SecureStorageService,
          { provide: HOST_CAPABILITY_NEGOTIATOR, useValue: { manifest } },
        ],
      });
      return {
        s: TestBed.inject(SecureStorageService),
        host: TestBed.inject(HostCapabilitiesService),
      };
    }

    it('rejects while the first negotiation is still in flight, then uses the keychain', async () => {
      // The preload answers "not available" until a negotiation grants the store.
      let granted = false;
      const answer = new Subject<HostCapabilityManifest>();
      const { s, host } = desktop(
        async () => granted,
        () => answer,
      );
      const negotiated = firstValueFrom(host.manifest());

      await expect(s.get('accessToken')).rejects.toThrow();
      await expect(s.set('accessToken', 'new')).rejects.toThrow();
      expect(await s.read('accessToken')).toEqual({ kind: 'unavailable' });
      expect(await s.removesByNameOnly()).toBe(false);
      expect(prefs.size).toBe(0);

      granted = true;
      answer.next(unavailableHostManifest('not-supported'));
      await negotiated;

      expect(await s.get('accessToken')).toBe('tok');
      expect(await s.isSecure()).toBe(true);
      expect(await s.removesByNameOnly()).toBe(true);
    });

    it('still falls back, with its warning signal, on a desktop the host says has no keyring', async () => {
      const { s, host } = desktop(
        async () => false,
        () => of(unavailableHostManifest('not-supported')),
      );
      await firstValueFrom(host.manifest());

      await s.set('accessToken', 'tok');

      expect(prefs.get('secure.accessToken')).toBe('tok');
      expect(await s.withoutKeychain()).toBe(true);
      expect(await s.removesByNameOnly()).toBe(false);
      expect(await s.awaitingHost()).toBe(false);
    });

    it('does not take a "not available" asked before the host answered as the host’s answer', async () => {
      const probe = deferredValue<boolean>();
      const negotiate = vi
        .fn(() => of(unavailableHostManifest('not-supported')))
        .mockReturnValueOnce(of(unavailableHostManifest('host-rejected')));
      const { s, host } = desktop(() => probe.promise, negotiate);
      await firstValueFrom(host.manifest());

      const read = s.get('accessToken');
      // The retry answers while the probe sent during the failure is still out.
      await firstValueFrom(host.manifest());
      probe.resolve(false);

      await expect(read).rejects.toThrow();
      expect(prefs.size).toBe(0);
    });

    it('reports the keychain as awaiting the host, asking the host again first', async () => {
      const negotiate = vi
        .fn(() => of(unavailableHostManifest('not-supported')))
        .mockReturnValueOnce(of(unavailableHostManifest('host-rejected')))
        .mockReturnValueOnce(of(unavailableHostManifest('host-rejected')));
      const { s, host } = desktop(async () => true, negotiate);
      await firstValueFrom(host.manifest());

      expect(await s.awaitingHost()).toBe(true);
      expect(await s.awaitingHost()).toBe(false);
      expect(negotiate).toHaveBeenCalledTimes(3);
    });

    it('stops waiting for a host that does not answer', async () => {
      vi.useFakeTimers();
      try {
        const { s } = desktop(
          async () => false,
          () => NEVER,
        );
        const awaiting = s.awaitingHost();
        await vi.advanceTimersByTimeAsync(3000);
        expect(await awaiting).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('is never awaiting a host off desktop', async () => {
      expect(await service().awaitingHost()).toBe(false);
    });
  });

  describe('clearAll', () => {
    it('sweeps the keychain and says it did, on native', async () => {
      vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
      vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true);
      const s = service();
      await s.set('accessToken', 'tok');

      await expect(s.clearAll()).resolves.toBe(true);
      expect(nativeStore.size).toBe(0);
    });

    it('reports false on web, where there is nothing to sweep', async () => {
      // Web keys live in Preferences, which the factory reset clears as a group — and the
      // `false` is what tells the caller its own per-key removals were the whole story.
      const s = service();
      await s.set('accessToken', 'tok');

      await expect(s.clearAll()).resolves.toBe(false);
      expect(prefs.get('secure.accessToken')).toBe('tok'); // untouched by this call
    });

    it('reports false rather than throwing when the keychain sweep fails', async () => {
      // A factory reset must not abort because the OS keyring refused; the caller's
      // per-key removals still stand.
      vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
      vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true);
      const { SecureStorage } =
        await import('@aparajita/capacitor-secure-storage');
      vi.spyOn(SecureStorage, 'clear').mockRejectedValueOnce(
        new Error('keyring locked'),
      );

      await expect(service().clearAll()).resolves.toBe(false);
    });
  });
});
