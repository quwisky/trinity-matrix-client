/** A persisted Matrix login session, restored on app start to recreate the client. */
export interface MatrixSession {
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  /**
   * IndexedDB name prefix for this account's Rust crypto store, passed to
   * `initRustCrypto({ cryptoDatabasePrefix })`. Assigned per account **and device**
   * (`trinity-crypto:${userId}:${deviceId}`) so multiple accounts on one device don't
   * share a single Olm store, and — crucially — so a fresh login (which mints a new
   * device id) never reopens a store an earlier device left behind (which the Rust
   * OlmMachine rejects as an account/device mismatch). Unset for a migrated
   * pre-multi-account session, which keeps the SDK default prefix so its existing
   * crypto store is preserved (no re-verification on upgrade), until its device changes.
   */
  cryptoPrefix?: string;
}
