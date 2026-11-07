import type {
  CryptoCallbacks,
  GeneratedSecretStorageKey,
} from 'matrix-js-sdk/lib/crypto-api';

/**
 * In-memory holder for one account's unlocked secret-storage (4S) private key, handed to
 * the SDK through the `getSecretStorageKey` callback wired in at client creation.
 *
 * The key is effectively the account's recovery key, so it lives in memory for the session
 * ONLY and is never written to disk.
 *
 * One holder per account: each `AccountClient` owns its own, so a background account's key
 * operation can never read, overwrite, or zero another account's key. Client teardown
 * clears it.
 */
export class SecretStorageKeyHolder {
  private keyId: string | null = null;
  private privateKey: Uint8Array<ArrayBuffer> | null = null;
  private unfinished: GeneratedSecretStorageKey | null = null;
  private torn = false;

  /** Whether {@link clear} ran: the account is gone and nothing should be cached here. */
  get released(): boolean {
    return this.torn;
  }

  /**
   * The recovery key a partly failed first setup already showed, kept so a retry reuses
   * it rather than minting another. Stored as a copy: the SDK and {@link set} zero the
   * buffers they are handed.
   */
  get unfinishedSetupKey(): GeneratedSecretStorageKey | null {
    return this.unfinished;
  }

  /** Remember (or, with null, zero and forget) {@link unfinishedSetupKey}. */
  holdUnfinishedSetupKey(key: GeneratedSecretStorageKey | null): void {
    this.unfinished?.privateKey.fill(0);
    // A setup still running when its account signed out must not leave a key behind.
    this.unfinished =
      key && !this.torn
        ? { ...key, privateKey: new Uint8Array(key.privateKey) }
        : null;
  }

  /** Cache the unlocked key for a key id (after generate or unlock). */
  set(keyId: string, privateKey: Uint8Array<ArrayBuffer>): void {
    // Zero the outgoing buffer: set() can run more than once during bootstrap/recovery and
    // the old value is the recovery key. Skip the same buffer, or the incoming key is wiped.
    if (this.privateKey && this.privateKey !== privateKey) {
      this.privateKey.fill(0);
    }
    this.keyId = keyId;
    this.privateKey = privateKey;
  }

  /**
   * Forget the key (on logout / client teardown), zeroing the bytes first as best-effort
   * defense-in-depth (the SDK keeps its own copy). Safe because teardown runs after the
   * client has stopped, so no crypto operation still reads the returned reference.
   */
  clear(): void {
    this.torn = true;
    this.holdUnfinishedSetupKey(null);
    this.privateKey?.fill(0);
    this.keyId = null;
    this.privateKey = null;
  }

  /** Whether a key is currently held in memory. */
  get hasKey(): boolean {
    return this.privateKey !== null;
  }

  /**
   * `cryptoCallbacks.getSecretStorageKey`: the cached `[keyId, privateKey]` when the
   * requested key id matches, otherwise `null` so the SDK operation fails fast and the flow
   * can prompt the user. Only one key is held, so matching on `keyId in keys` suffices.
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
   * `cryptoCallbacks.cacheSecretStorageKey`: called when bootstrap creates a new default
   * key, so the reads that follow need no second prompt.
   */
  readonly cacheSecretStorageKey: NonNullable<
    CryptoCallbacks['cacheSecretStorageKey']
  > = (keyId, _keyInfo, key) => {
    this.set(keyId, key);
  };
}
