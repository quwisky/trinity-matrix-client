import { TestBed } from '@angular/core/testing';
import { SecretStorageKeyService } from './secret-storage-key.service';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SecretStorageKeyDescription } from 'matrix-js-sdk/lib/secret-storage';

// A 4S key id always maps to a key description; the callback only reads the keys.
const desc = {} as SecretStorageKeyDescription;

describe('SecretStorageKeyService', () => {
  let keys: SecretStorageKeyService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [SecretStorageKeyService] });
    keys = TestBed.inject(SecretStorageKeyService);
  });

  it('returns null and reports no key before one is set', async () => {
    expect(keys.hasKey).toBe(false);
    expect(await keys.getSecretStorageKey({ keys: { abc: desc } }, 'm.x')).toBe(
      null,
    );
  });

  it('returns [keyId, privateKey] when the held key is requested', async () => {
    const key = new Uint8Array([1, 2, 3]);
    keys.set('abc', key);

    expect(keys.hasKey).toBe(true);
    expect(
      await keys.getSecretStorageKey({ keys: { abc: desc } }, 'm.x'),
    ).toEqual(['abc', key]);
  });

  it('returns null when the held key id is not among the requested keys', async () => {
    keys.set('abc', new Uint8Array([1]));
    expect(
      await keys.getSecretStorageKey({ keys: { other: desc } }, 'm.x'),
    ).toBe(null);
  });

  it('matches the held key among several requested keys', async () => {
    const key = new Uint8Array([7]);
    keys.set('abc', key);
    expect(
      await keys.getSecretStorageKey(
        { keys: { other: desc, abc: desc } },
        'm.x',
      ),
    ).toEqual(['abc', key]);
  });

  it('caches a newly created key via cacheSecretStorageKey', async () => {
    const key = new Uint8Array([9]);
    keys.cacheSecretStorageKey('new', desc, key);

    expect(keys.hasKey).toBe(true);
    expect(
      await keys.getSecretStorageKey({ keys: { new: desc } }, 'm.x'),
    ).toEqual(['new', key]);
  });

  it('overwrites a previously held key when a new one is cached', async () => {
    keys.set('old', new Uint8Array([1]));
    const newKey = new Uint8Array([2]);
    keys.cacheSecretStorageKey('new', desc, newKey);

    expect(await keys.getSecretStorageKey({ keys: { old: desc } }, 'm.x')).toBe(
      null,
    );
    expect(
      await keys.getSecretStorageKey({ keys: { new: desc } }, 'm.x'),
    ).toEqual(['new', newKey]);
  });

  it('zeroes the previous key buffer when set() overwrites it', () => {
    const first = new Uint8Array([1, 2, 3]);
    keys.set('a', first);
    keys.set('b', new Uint8Array([4, 5, 6]));
    // The replaced buffer (the account recovery key) is wiped, not just dropped.
    expect(Array.from(first)).toEqual([0, 0, 0]);
  });

  it('does not zero the incoming buffer when set() re-sets the same reference', () => {
    const key = new Uint8Array([1, 2, 3]);
    keys.set('a', key);
    keys.set('a', key);
    expect(Array.from(key)).toEqual([1, 2, 3]);
  });

  it('forgets and zeroes the key on clear()', async () => {
    const key = new Uint8Array([1, 2, 3]);
    keys.set('abc', key);
    keys.clear();

    expect(keys.hasKey).toBe(false);
    expect(await keys.getSecretStorageKey({ keys: { abc: desc } }, 'm.x')).toBe(
      null,
    );
    // The held buffer is wiped, not just dereferenced.
    expect(Array.from(key)).toEqual([0, 0, 0]);
  });
});
