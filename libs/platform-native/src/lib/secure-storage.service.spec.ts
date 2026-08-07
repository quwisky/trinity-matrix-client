import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecureStorageService } from './secure-storage.service';

// In-memory @capacitor/preferences + the native keychain plugin (hoisted so the
// vi.mock factories can see them).
const { prefs, nativeStore } = vi.hoisted(() => ({
  prefs: new Map<string, string>(),
  nativeStore: new Map<string, string>(),
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
  SecureStorage: {
    get: async (key: string) => nativeStore.get(key) ?? null,
    set: async (key: string, value: string) => {
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
