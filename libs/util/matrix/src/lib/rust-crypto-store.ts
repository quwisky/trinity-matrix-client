/**
 * matrix-js-sdk's default Rust crypto-store prefix (its `RUST_SDK_STORE_PREFIX`), used by a
 * migrated pre-multi-account session with no per-account prefix.
 */
const DEFAULT_RUST_CRYPTO_PREFIX = 'matrix-js-sdk';

/** The prefix `IndexedDBLocalBackend` prepends to every IndexedDB name it is given. */
const SDK_DB_NAME_PREFIX = 'matrix-js-sdk:';

/** Our own per-account namespace for the message sync store, before the SDK's prefix. */
const SYNC_STORE_PREFIX = 'trinity-sync:';

/** The two IndexedDB suffixes matrix-js-sdk appends to a `cryptoDatabasePrefix`. */
const RUST_CRYPTO_DB_SUFFIXES = [
  '::matrix-sdk-crypto',
  '::matrix-sdk-crypto-meta',
] as const;

/**
 * The IndexedDB database names matrix-js-sdk's Rust crypto uses for a `cryptoDatabasePrefix`:
 * the exact pair `initRustCrypto` creates and `clearStores` deletes. An undefined prefix
 * resolves to the SDK default.
 */
export function rustCryptoStoreDbNames(
  prefix: string | undefined,
): readonly [string, string] {
  const base = prefix ?? DEFAULT_RUST_CRYPTO_PREFIX;
  return [
    `${base}${RUST_CRYPTO_DB_SUFFIXES[0]}`,
    `${base}${RUST_CRYPTO_DB_SUFFIXES[1]}`,
  ];
}

/**
 * Whether `dbName` is one of matrix-js-sdk's Rust crypto-store databases, for picking them
 * out of an `indexedDB.databases()` listing without touching the sync store or others.
 */
export function isRustCryptoStoreDbName(dbName: string): boolean {
  return RUST_CRYPTO_DB_SUFFIXES.some((suffix) => dbName.endsWith(suffix));
}

/** What the app passes as `IndexedDBStore({ dbName })` for an account's message sync store. */
export function syncStoreDbName(userId: string): string {
  return `${SYNC_STORE_PREFIX}${userId}`;
}

/**
 * The name the sync store ACTUALLY has on disk: `IndexedDBLocalBackend` prepends
 * `matrix-js-sdk:` to the `dbName`, so deleting or enumerating by `dbName` would silently
 * match nothing.
 */
export function syncStoreIndexedDbName(userId: string): string {
  return `${SDK_DB_NAME_PREFIX}${syncStoreDbName(userId)}`;
}

/** Whether `dbName` is a Trinity sync store, for picking them out of a database listing. */
export function isSyncStoreDbName(dbName: string): boolean {
  return dbName.startsWith(`${SDK_DB_NAME_PREFIX}${SYNC_STORE_PREFIX}`);
}
