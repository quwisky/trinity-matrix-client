import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecureStorageService } from './secure-storage.service';

// In-memory @capacitor/preferences (hoisted for the vi.mock factory).
const { prefs } = vi.hoisted(() => ({ prefs: new Map<string, string>() }));
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

describe('SecureStorageService (web fallback)', () => {
  beforeEach(() => prefs.clear());

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
});
