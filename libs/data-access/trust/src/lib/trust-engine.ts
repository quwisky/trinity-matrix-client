import type { Observable } from 'rxjs';
import type { EngineResult } from '@trinity/util/matrix';

/** The cross-signing keys this device knows about. Rust: `Encryption::cross_signing_status()`. */
export interface CrossSigningFacts {
  readonly publicKeysOnDevice: boolean;
  readonly privateKeysInSecretStorage: boolean;
  readonly privateKeysCachedLocally: {
    readonly masterKey: boolean;
    readonly selfSigningKey: boolean;
    readonly userSigningKey: boolean;
  };
}

/** One account's raw crypto facts; Trust derives its status from these (`deriveTrustSnapshot`). */
export interface TrustFacts {
  /** This device trusts the account's identity and holds its private keys (js `isCrossSigningReady`). */
  readonly crossSigningReady: boolean;
  /** js `isSecretStorageReady`. */
  readonly secretStorageReady: boolean;
  /** A key backup is active on this device. */
  readonly keyBackupActive: boolean;
  /**
   * The LOCAL store's secret-storage default key pointer is set. It can lag the server, so
   * it never gates a destructive step; see {@link TrustEngine.serverDefaultKeyId}.
   */
  readonly hasDefaultKey: boolean;
  /** This device is cross-signed by its own identity; local trust alone does not count. */
  readonly thisDeviceCrossSigned: boolean;
  readonly crossSigning: CrossSigningFacts;
}

/** The account's identity as the server has it, read after re-querying the server. */
export interface OwnIdentityCheck {
  /** The account has an identity once the own keys are re-queried (js `userHasCrossSigningKeys(me, true)`). */
  readonly identityKnown: boolean;
  /** The published master key (`/keys/query`); null when the server publishes none. */
  readonly publishedMasterKey: string | null;
  /** The local master public key; null when this device has none or it does not match its private key. */
  readonly localMasterKey: string | null;
  readonly facts: TrustFacts;
}

/** A password prompt raised inside an interactive command, then exactly one `done`. */
export type InteractiveUpdate<T> =
  | {
      readonly kind: 'password-required';
      readonly promptId: string;
      readonly rejected: boolean;
    }
  | { readonly kind: 'done'; readonly result: EngineResult<T> };

/**
 * One account's crypto, as plain data. The engine reports facts and runs protocol steps;
 * Trust owns every status decision and message.
 */
export interface TrustEngine {
  /**
   * The account's facts on subscribe (once read), then again after each crypto or
   * account-data change that can move them. `account-not-live` or `crypto-not-ready` for
   * an account without a client or crypto; a failed read is a `request-failed` value and
   * the next change reads again. A replaced client is not followed: subscribe again.
   */
  facts(accountId: string): Observable<EngineResult<TrustFacts>>;
  /** Re-queries the own keys first, so the local match is judged against the server's copy. */
  ownIdentityCheck(
    accountId: string,
  ): Observable<EngineResult<OwnIdentityCheck>>;
  /**
   * The published master key from one `/keys/query` of the own user; null when the server
   * publishes none. No forced re-query and no local reads, unlike {@link ownIdentityCheck}.
   */
  publishedMasterKey(
    accountId: string,
  ): Observable<EngineResult<string | null>>;
  /** The SERVER's `m.secret_storage.default_key` key id; null when it has none. */
  serverDefaultKeyId(
    accountId: string,
  ): Observable<EngineResult<string | null>>;
}
