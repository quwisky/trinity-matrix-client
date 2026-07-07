/**
 * matrix-js-sdk's default Rust crypto-store prefix (its exported `RUST_SDK_STORE_PREFIX`),
 * used when an account has no per-account prefix — a migrated pre-multi-account session that
 * stays on the SDK default store.
 */
const DEFAULT_RUST_CRYPTO_PREFIX = 'matrix-js-sdk';

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
