import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoStoreKeyService } from './crypto-store-key.service';
import { SecureStorageService } from './secure-storage.service';

// jsdom ships no IndexedDB, so the web wrapping keys are held in a Map here. The real
// IndexedDB holder runs in the browser journeys (sign-in, restart and factory reset).
const { wrappingKeys, wrappingKeyDb } = vi.hoisted(() => ({
  wrappingKeys: new Map<string, CryptoKey>(),
  wrappingKeyDb: { failing: false },
}));
vi.mock('./crypto-store-wrapping-keys', () => ({
  loadWrappingKey: async (id: string) => {
    if (wrappingKeyDb.failing) throw new Error('IndexedDB unavailable');
    return wrappingKeys.get(id);
  },
  // Like the IndexedDB `add` it stands in for: an existing entry is never replaced.
  saveWrappingKey: async (id: string, key: CryptoKey) => {
    if (wrappingKeys.has(id)) throw new Error('ConstraintError');
    wrappingKeys.set(id, key);
  },
  deleteWrappingKey: async (id: string) => {
    wrappingKeys.delete(id);
  },
}));

/** The real service over an in-memory secure store that reports `isSecure`. */
function setup(isSecure: boolean) {
  const store = new Map<string, string>();
  TestBed.configureTestingModule({
    providers: [CryptoStoreKeyService, MockProvider(SecureStorageService)],
  });
  const secure = TestBed.inject(SecureStorageService);
  vi.mocked(secure.isSecure).mockResolvedValue(isSecure);
  vi.mocked(secure.read).mockImplementation(async (key) => {
    const value = store.get(key);
    return value === undefined
      ? { kind: 'absent' }
      : { kind: 'present', value };
  });
  vi.mocked(secure.set).mockImplementation(async (key, value) => {
    store.set(key, value);
  });
  vi.mocked(secure.remove).mockImplementation(async (key) => {
    store.delete(key);
  });
  return { keys: TestBed.inject(CryptoStoreKeyService), store, secure };
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe('CryptoStoreKeyService', () => {
  beforeEach(() => {
    wrappingKeys.clear();
    wrappingKeyDb.failing = false;
  });

  describe('behind an OS keychain or keystore', () => {
    it('creates a random 32-byte key and keeps it in secure storage under its store', async () => {
      const { keys, store } = setup(true);

      const key = await keys.create('trinity-crypto:@alice:hs:DEV1');

      expect(key).toBeInstanceOf(Uint8Array);
      expect(key).toHaveLength(32);
      expect(
        store.get('matrix.cryptoStoreKey:trinity-crypto:@alice:hs:DEV1'),
      ).toBe(base64(key));
      expect(await keys.read('trinity-crypto:@alice:hs:DEV1')).toEqual({
        kind: 'present',
        key: key,
      });
      // The keychain protects it, so nothing is wrapped.
      expect(wrappingKeys.size).toBe(0);
    });

    it('refuses to replace a store key that already exists', async () => {
      const { keys } = setup(true);
      const first = await keys.create('trinity-crypto:@alice:hs:DEV1');

      await expect(
        keys.create('trinity-crypto:@alice:hs:DEV1'),
      ).rejects.toThrow(/already has a key/);
      expect(await keys.read('trinity-crypto:@alice:hs:DEV1')).toEqual({
        kind: 'present',
        key: first,
      });
    });

    it('refuses to create a key while the keychain cannot say whether one exists', async () => {
      const { keys, secure } = setup(true);
      vi.mocked(secure.read).mockResolvedValue({ kind: 'unavailable' });

      await expect(
        keys.create('trinity-crypto:@alice:hs:DEV1'),
      ).rejects.toThrow();
      expect(secure.set).not.toHaveBeenCalled();
    });

    it('says unavailable, not missing, while the keychain cannot be read', async () => {
      const { keys, secure } = setup(true);
      await keys.create('trinity-crypto:@alice:hs:DEV1');
      vi.mocked(secure.read).mockResolvedValue({ kind: 'unavailable' });

      expect(await keys.read('trinity-crypto:@alice:hs:DEV1')).toEqual({
        kind: 'unavailable',
      });
    });

    it('has no key for an account that never got one', async () => {
      const { keys } = setup(true);

      expect(await keys.read('trinity-crypto:@alice:hs:DEV1')).toEqual({
        kind: 'missing',
      });
    });

    it('gives each store its own key', async () => {
      const { keys } = setup(true);

      const alice = await keys.create('trinity-crypto:@alice:hs:DEV1');
      const bob = await keys.create('trinity-crypto:@bob:hs:DEV2');

      expect(alice).not.toEqual(bob);
      expect(await keys.read('trinity-crypto:@alice:hs:DEV1')).toEqual({
        kind: 'present',
        key: alice,
      });
      expect(await keys.read('trinity-crypto:@bob:hs:DEV2')).toEqual({
        kind: 'present',
        key: bob,
      });
    });

    it('deletes only the named store key', async () => {
      const { keys } = setup(true);
      await keys.create('trinity-crypto:@alice:hs:DEV1');
      const bob = await keys.create('trinity-crypto:@bob:hs:DEV2');

      await keys.remove('trinity-crypto:@alice:hs:DEV1');

      expect(await keys.read('trinity-crypto:@alice:hs:DEV1')).toEqual({
        kind: 'missing',
      });
      expect(await keys.read('trinity-crypto:@bob:hs:DEV2')).toEqual({
        kind: 'present',
        key: bob,
      });
    });
  });

  describe('on the web, where secure storage is plain storage', () => {
    it('stores the key wrapped, never the raw bytes, and unwraps it', async () => {
      const { keys, store } = setup(false);

      const key = await keys.create('trinity-crypto:@alice:hs:DEV1');

      const stored =
        store.get('matrix.cryptoStoreKey:trinity-crypto:@alice:hs:DEV1') ?? '';
      expect(stored).not.toBe('');
      expect(stored).not.toContain(base64(key));
      expect(await keys.read('trinity-crypto:@alice:hs:DEV1')).toEqual({
        kind: 'present',
        key: key,
      });
    });

    it('creates a key on a desktop without a keychain, whose plain store reports none as unavailable', async () => {
      const { keys, store, secure } = setup(false);
      vi.mocked(secure.read).mockImplementation(async (key) => {
        const value = store.get(key);
        return value === undefined
          ? { kind: 'unavailable' }
          : { kind: 'present', value };
      });

      const key = await keys.create('trinity-crypto:@alice:hs:DEV1');

      expect(await keys.read('trinity-crypto:@alice:hs:DEV1')).toEqual({
        kind: 'present',
        key,
      });
      await expect(
        keys.create('trinity-crypto:@alice:hs:DEV1'),
      ).rejects.toThrow(/already has a key/);
    });

    it('refuses to replace a store key that already exists', async () => {
      const { keys } = setup(false);
      const first = await keys.create('trinity-crypto:@alice:hs:DEV1');
      const wrappingKey = wrappingKeys.get('trinity-crypto:@alice:hs:DEV1');

      await expect(
        keys.create('trinity-crypto:@alice:hs:DEV1'),
      ).rejects.toThrow();
      expect(wrappingKeys.get('trinity-crypto:@alice:hs:DEV1')).toBe(
        wrappingKey,
      );
      expect(await keys.read('trinity-crypto:@alice:hs:DEV1')).toEqual({
        kind: 'present',
        key: first,
      });
    });

    it('removes its wrapping key when the wrapped key cannot be saved, so a retry works', async () => {
      const { keys, secure } = setup(false);
      vi.mocked(secure.set).mockRejectedValueOnce(new Error('write failed'));

      await expect(
        keys.create('trinity-crypto:@alice:hs:DEV1'),
      ).rejects.toThrow('write failed');
      expect(wrappingKeys.has('trinity-crypto:@alice:hs:DEV1')).toBe(false);

      const key = await keys.create('trinity-crypto:@alice:hs:DEV1');
      expect(await keys.read('trinity-crypto:@alice:hs:DEV1')).toEqual({
        kind: 'present',
        key,
      });
    });

    it('removes its wrapping key when wrapping fails after saving it, so a retry works', async () => {
      const { keys } = setup(false);
      vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(
        new Error('encrypt failed'),
      );

      await expect(
        keys.create('trinity-crypto:@alice:hs:DEV1'),
      ).rejects.toThrow('encrypt failed');
      expect(wrappingKeys.has('trinity-crypto:@alice:hs:DEV1')).toBe(false);

      const key = await keys.create('trinity-crypto:@alice:hs:DEV1');
      expect(await keys.read('trinity-crypto:@alice:hs:DEV1')).toEqual({
        kind: 'present',
        key,
      });
    });

    it('keeps a wrapping key it did not save when saving its own is refused', async () => {
      const { keys } = setup(false);
      const theirs = {} as CryptoKey;
      wrappingKeys.set('trinity-crypto:@alice:hs:DEV1', theirs);

      await expect(
        keys.create('trinity-crypto:@alice:hs:DEV1'),
      ).rejects.toThrow();
      expect(wrappingKeys.get('trinity-crypto:@alice:hs:DEV1')).toBe(theirs);
    });

    it('wraps with a non-extractable AES-GCM key', async () => {
      const { keys } = setup(false);

      await keys.create('trinity-crypto:@alice:hs:DEV1');

      const wrappingKey = wrappingKeys.get('trinity-crypto:@alice:hs:DEV1');
      expect(wrappingKey?.algorithm.name).toBe('AES-GCM');
      expect(wrappingKey?.extractable).toBe(false);
      await expect(
        crypto.subtle.exportKey('raw', wrappingKey as CryptoKey),
      ).rejects.toThrow();
    });

    it('says unavailable, not missing, when the wrapping-key database cannot be read', async () => {
      const { keys } = setup(false);
      await keys.create('trinity-crypto:@alice:hs:DEV1');
      wrappingKeyDb.failing = true;

      expect(await keys.read('trinity-crypto:@alice:hs:DEV1')).toEqual({
        kind: 'unavailable',
      });
    });

    it('cannot unwrap the key once its wrapping key is deleted', async () => {
      const { keys, store } = setup(false);
      await keys.create('trinity-crypto:@alice:hs:DEV1');

      wrappingKeys.delete('trinity-crypto:@alice:hs:DEV1');

      // The wrapped value is still there, but nothing can read it any more.
      expect(
        store.has('matrix.cryptoStoreKey:trinity-crypto:@alice:hs:DEV1'),
      ).toBe(true);
      expect(await keys.read('trinity-crypto:@alice:hs:DEV1')).toEqual({
        kind: 'missing',
      });
    });

    it('deletes both the wrapped key and its wrapping key', async () => {
      const { keys, store } = setup(false);
      await keys.create('trinity-crypto:@alice:hs:DEV1');

      await keys.remove('trinity-crypto:@alice:hs:DEV1');

      expect(
        store.has('matrix.cryptoStoreKey:trinity-crypto:@alice:hs:DEV1'),
      ).toBe(false);
      expect(wrappingKeys.has('trinity-crypto:@alice:hs:DEV1')).toBe(false);
      expect(await keys.read('trinity-crypto:@alice:hs:DEV1')).toEqual({
        kind: 'missing',
      });
    });
  });
});
