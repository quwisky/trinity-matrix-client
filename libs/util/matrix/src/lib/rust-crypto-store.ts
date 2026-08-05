/**
 * matrix-js-sdk's default Rust crypto-store prefix (its exported `RUST_SDK_STORE_PREFIX`),
 * used when an account has no per-account prefix — a migrated pre-multi-account session that
 * stays on the SDK default store.
 */
const DEFAULT_RUST_CRYPTO_PREFIX = 'matrix-js-sdk';

/**
 * The prefix matrix-js-sdk prepends to every IndexedDB name it is given
 * (`IndexedDBLocalBackend`: `this.dbName = "matrix-js-sdk:" + dbName`).
 */
const SDK_DB_NAME_PREFIX = 'matrix-js-sdk:';

/** Our own per-account namespace for the message sync store, before the SDK's prefix. */
const SYNC_STORE_PREFIX = 'trinity-sync:';

/** The two IndexedDB suffixes matrix-js-sdk appends to a `cryptoDatabasePrefix`. */
const RUST_CRYPTO_DB_SUFFIXES = [
  '::matrix-sdk-crypto',
  '::matrix-sdk-crypto-meta',
] as const;

/**
 * The IndexedDB database names matrix-js-sdk's Rust crypto uses for a given
 * `cryptoDatabasePrefix` — `${prefix}::matrix-sdk-crypto` and `${prefix}::matrix-sdk-crypto-meta`
 * — the exact pair `initRustCrypto` creates and `clearStores` deletes. An undefined prefix
 * resolves to the SDK default, matching a migrated legacy account's store. Kept here (not
 * duplicated at call sites) so this SDK naming convention lives in one place.
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
 * Whether `dbName` is one of matrix-js-sdk's Rust crypto-store IndexedDB databases (i.e. ends
 * with a known crypto suffix). Used to pick crypto stores out of an `indexedDB.databases()`
 * listing when sweeping orphans — so the message-sync store and unrelated databases are left
 * alone.
 */
export function isRustCryptoStoreDbName(dbName: string): boolean {
  return RUST_CRYPTO_DB_SUFFIXES.some((suffix) => dbName.endsWith(suffix));
}

/** What the app passes as `IndexedDBStore({ dbName })` for an account's message sync store. */
export function syncStoreDbName(userId: string): string {
  return `${SYNC_STORE_PREFIX}${userId}`;
}

/**
 * The name the sync store ACTUALLY has on disk.
 *
 * matrix-js-sdk does not use `dbName` verbatim: `IndexedDBLocalBackend` prepends
 * `matrix-js-sdk:` to whatever it is given. So the database the app creates as
 * `trinity-sync:@me:hs` is really `matrix-js-sdk:trinity-sync:@me:hs`, and anything deleting
 * or enumerating it by name must use THIS form — passing the `dbName` would silently delete
 * nothing. Kept beside the crypto-store names so both SDK naming conventions live together.
 */
export function syncStoreIndexedDbName(userId: string): string {
  return `${SDK_DB_NAME_PREFIX}${syncStoreDbName(userId)}`;
}

/** Whether `dbName` is a Trinity sync store, for picking them out of a database listing. */
export function isSyncStoreDbName(dbName: string): boolean {
  return dbName.startsWith(`${SDK_DB_NAME_PREFIX}${SYNC_STORE_PREFIX}`);
}
