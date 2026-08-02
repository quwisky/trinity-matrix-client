import { describe, expect, it } from 'vitest';
import {
  isRustCryptoStoreDbName,
  rustCryptoStoreDbNames,
} from './rust-crypto-store';

describe('rustCryptoStoreDbNames', () => {
  it('derives the crypto + meta IndexedDB names for a per-account prefix', () => {
    expect(rustCryptoStoreDbNames('trinity-crypto:@me:hs:DEV')).toEqual([
      'trinity-crypto:@me:hs:DEV::matrix-sdk-crypto',
      'trinity-crypto:@me:hs:DEV::matrix-sdk-crypto-meta',
    ]);
  });

  it('falls back to the SDK default store for an undefined prefix (legacy account)', () => {
    // Must match what clearStores({ cryptoDatabasePrefix: undefined }) targets.
    expect(rustCryptoStoreDbNames(undefined)).toEqual([
      'matrix-js-sdk::matrix-sdk-crypto',
      'matrix-js-sdk::matrix-sdk-crypto-meta',
    ]);
  });
});

describe('isRustCryptoStoreDbName', () => {
  it('recognizes both crypto-store database suffixes', () => {
    expect(
      isRustCryptoStoreDbName('trinity-crypto:@me:hs:DEV::matrix-sdk-crypto'),
    ).toBe(true);
    expect(
      isRustCryptoStoreDbName(
        'trinity-crypto:@me:hs:DEV::matrix-sdk-crypto-meta',
      ),
    ).toBe(true);
    expect(isRustCryptoStoreDbName('matrix-js-sdk::matrix-sdk-crypto')).toBe(
      true,
    );
  });

  it('rejects non-crypto databases (sync store, unrelated names)', () => {
    expect(isRustCryptoStoreDbName('trinity-sync:@me:hs')).toBe(false);
    expect(isRustCryptoStoreDbName('some-other-db')).toBe(false);
    expect(isRustCryptoStoreDbName('')).toBe(false);
  });
});
