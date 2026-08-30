import type { CryptoCallbacks } from 'matrix-js-sdk/lib/crypto-api';

/**
 * In-memory holder for one account's unlocked secret-storage (4S) private key.
 *
 * The Rust crypto stack asks for the secret-storage key whenever it reads or
 * writes 4S — cross-signing setup, key backup, and recovering a fresh device.
 * The unlocked key is kept in memory for the session ONLY: it is effectively the
 * account's recovery key, so it is never written to disk. It is handed to the SDK
 * through the `getSecretStorageKey` callback wired into that account's MatrixClient
 * at creation (see MatrixClientService).
 *
 * One holder per account: each {@link MatrixClientService} `AccountClient` owns its
 * own so a background account's key operation can never read, overwrite, or zero
 * another account's key. TrustService populates the active account's holder during
 * the setup/recovery flows; client teardown clears it.
 */
export class SecretStorageKeyHolder {
  private keyId: string | null = null;
  private privateKey: Uint8Array<ArrayBuffer> | null = null;

  /** Cache the unlocked key for a key id (after generate or unlock). */
  set(keyId: string, privateKey: Uint8Array<ArrayBuffer>): void {
    // Zero the outgoing buffer before replacing it — set() can run more than once
    // during bootstrap/recovery (e.g. cacheSecretStorageKey right after a manual
    // set), and the old value is the account recovery key. Skip when it's the same
    // buffer, which would wipe the incoming key too.
    if (this.privateKey && this.privateKey !== privateKey) {
      this.privateKey.fill(0);
    }
    this.keyId = keyId;
    this.privateKey = privateKey;
  }

  /**
   * Forget the key (on logout / client teardown). Zeroes the bytes first as
   * best-effort defense-in-depth — the GC reclaims the buffer on its own schedule
   * and the SDK keeps its own copy, but we wipe the one we control. Safe here
   * because teardown happens after the client has stopped, so no crypto operation
   * is still reading the reference returned by {@link getSecretStorageKey}.
   */
  clear(): void {
    this.privateKey?.fill(0);
    this.keyId = null;
    this.privateKey = null;
  }

  /** Whether a key is currently held in memory. */
  get hasKey(): boolean {
    return this.privateKey !== null;
  }

  /**
   * `cryptoCallbacks.getSecretStorageKey`: return the cached `[keyId, privateKey]`
   * when the requested key id matches the one we hold, otherwise `null` so the SDK
   * operation fails fast and the setup/recovery flow can prompt the user.
   *
   * We deliberately hold a single key at a time (the one the user just generated or
   * unlocked), so matching on `this.keyId in keys` is sufficient and the SDK's
   * suggested `getDefaultKeyId()` lookup is unnecessary here.
   *
   * An arrow field so `this` stays bound when passed to `createClient`.
   */
  readonly getSecretStorageKey: NonNullable<
    CryptoCallbacks['getSecretStorageKey']
  > = async ({ keys }) => {
    if (!this.keyId || !this.privateKey || !(this.keyId in keys)) {
      return null;
    }
    return [this.keyId, this.privateKey];
  };

  /**
   * `cryptoCallbacks.cacheSecretStorageKey`: the SDK calls this when a new default
   * key is created during bootstrap, so we cache it for the immediately-following
   * reads without prompting the user again.
   */
  readonly cacheSecretStorageKey: NonNullable<
    CryptoCallbacks['cacheSecretStorageKey']
  > = (keyId, _keyInfo, key) => {
    this.set(keyId, key);
  };
}
