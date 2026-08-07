import { describe, expect, it } from 'vitest';
import {
  isRustCryptoStoreDbName,
  isSyncStoreDbName,
  rustCryptoStoreDbNames,
  syncStoreDbName,
  syncStoreIndexedDbName,
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

describe('sync store names', () => {
  it('passes the SDK the un-prefixed name, and reports the prefixed one on disk', () => {
    // The whole reason both functions exist. matrix-js-sdk takes `dbName` and stores under
    // `matrix-js-sdk:${dbName}`, so the value handed to IndexedDBStore and the value a
    // delete or an enumeration must use are DIFFERENT strings. Collapsing them — having
    // either function return the other's value — deletes nothing at all while every
    // "cleared" claim still reports success.
    expect(syncStoreDbName('@me:hs')).toBe('trinity-sync:@me:hs');
    expect(syncStoreIndexedDbName('@me:hs')).toBe(
      'matrix-js-sdk:trinity-sync:@me:hs',
    );
  });

  it('recognizes the name it produces, so the wipe and the sweep cannot drift apart', () => {
    // Producer and predicate carry the prefixes separately. Changing one without the other
    // leaves both halves individually plausible and the pair silently broken: the sweep
    // stops recognising the very databases the app creates.
    expect(isSyncStoreDbName(syncStoreIndexedDbName('@me:hs'))).toBe(true);
  });

  it('rejects the un-prefixed dbName, which never appears in a real listing', () => {
    // `indexedDB.databases()` reports on-disk names. Accepting the app-side form would make
    // the predicate look right in a test that fabricated its own listing while missing
    // every real one.
    expect(isSyncStoreDbName('trinity-sync:@me:hs')).toBe(false);
    expect(isSyncStoreDbName('some-other-db')).toBe(false);
    expect(isSyncStoreDbName('')).toBe(false);
  });

  it('partitions cleanly against the crypto predicate', () => {
    // session-storage.service ORs these two to decide whether a database is ours. An
    // overlap would make an account's crypto store answer to the sync branch as well.
    const sync = syncStoreIndexedDbName('@me:hs');
    const [crypto] = rustCryptoStoreDbNames('trinity-crypto:@me:hs:DEV');

    expect([isSyncStoreDbName(sync), isRustCryptoStoreDbName(sync)]).toEqual([
      true,
      false,
    ]);
    expect([
      isSyncStoreDbName(crypto),
      isRustCryptoStoreDbName(crypto),
    ]).toEqual([false, true]);
  });

  it('does not claim the SDK-default crypto store, which shares the SDK prefix', () => {
    // The only name that can actually fool this predicate, and the reason it matches on
    // `matrix-js-sdk:trinity-sync:` rather than on the SDK prefix alone: a legacy account's
    // crypto pair is `matrix-js-sdk::matrix-sdk-crypto`, which starts with `matrix-js-sdk:`
    // too. Loosening the check to the SDK prefix leaves every other test here green while
    // the sweep starts reading crypto stores as sync stores.
    expect(isSyncStoreDbName('matrix-js-sdk::matrix-sdk-crypto')).toBe(false);
    expect(isSyncStoreDbName('matrix-js-sdk::matrix-sdk-crypto-meta')).toBe(
      false,
    );
  });
});
