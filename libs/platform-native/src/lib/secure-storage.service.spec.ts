import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecureStorageService } from './secure-storage.service';
import { desktopBridgeFixture } from '@trinity/testing';

// In-memory @capacitor/preferences + the native keychain plugin (hoisted so the
// vi.mock factories can see them).
const { prefs, nativeStore, nativeSet } = vi.hoisted(() => ({
  prefs: new Map<string, string>(),
  nativeStore: new Map<string, string>(),
  nativeSet: { calls: [] as unknown[][] },
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

describe('SecureStorageService', () => {
  beforeEach(() => {
    prefs.clear();
    nativeStore.clear();
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
