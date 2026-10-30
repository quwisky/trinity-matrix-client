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

/**
 * The account's identity as the server has it, read after re-querying the server. When
 * the re-query knows no identity, nothing else is read.
 */
export type OwnIdentityCheck =
  | { readonly identityKnown: false }
  | {
      /** The account has an identity once the own keys are re-queried (js `userHasCrossSigningKeys(me, true)`). */
      readonly identityKnown: true;
      /** The published master key (`/keys/query`); null when the server publishes none. */
      readonly publishedMasterKey: string | null;
      /** The local master public key; null when this device has none or it does not match its private key. */
      readonly localMasterKey: string | null;
      readonly facts: TrustFacts;
    };

/** One signed-in device of the account, as the server lists it. */
export interface OwnDevice {
  readonly deviceId: string;
  /** null when the device has no display name. */
  readonly displayName: string | null;
  readonly lastSeenTs: number | null;
  readonly lastSeenIp: string | null;
  /** The device this engine runs as. */
  readonly isCurrent: boolean;
  /**
   * Locally verified or cross-signed (js `isVerified()`), unlike
   * {@link TrustFacts.thisDeviceCrossSigned}. A failed read counts as unverified.
   */
  readonly verified: boolean;
}

/** How the account sees another user's cross-signing identity. */
export interface UserTrustFacts {
  /** The current identity is cross-signing verified. */
  readonly verified: boolean;
  /** An identity of this user was verified at some point. */
  readonly wasVerified: boolean;
  /** The identity changed after a different one was pinned. */
  readonly needsApproval: boolean;
}

/** A password prompt raised inside an interactive command, then exactly one `done`. */
export type InteractiveUpdate<T> =
  | {
      readonly kind: 'password-required';
      readonly promptId: string;
      readonly rejected: boolean;
    }
  | { readonly kind: 'done'; readonly result: EngineResult<T> };

export type VerificationPhase =
  'requested' | 'ready' | 'started' | 'done' | 'cancelled';

export type VerificationMethod =
  'm.sas.v1' | 'm.qr_code.show.v1' | 'm.qr_code.scan.v1' | 'm.reciprocate.v1';

/** The account's current verification, as plain data. Never carries QR bytes. */
export interface VerificationSnapshot {
  readonly flowId: string;
  readonly phase: VerificationPhase;
  readonly otherUserId: string;
  /** As the other device sent it, unfiltered; null until it is known. */
  readonly otherDeviceId: string | null;
  readonly isSelfVerification: boolean;
  readonly initiatedByMe: boolean;
  /** The methods the other side supports; empty until it has answered. */
  readonly theirMethods: readonly VerificationMethod[];
  /** Set once the SAS keys are exchanged. */
  readonly sas: {
    readonly emoji: readonly {
      readonly glyph: string;
      readonly name: string;
    }[];
  } | null;
  /** The other device scanned this one's QR code and waits for {@link TrustEngine.confirmQr}. */
  readonly qrScannedByOther: boolean;
  /** Protocol timeouts arrive here too, as `m.timeout`. */
  readonly cancellation: { readonly code: string } | null;
}

/** What unlocks the account's secret storage: its recovery key or recovery passphrase. */
export type RecoverySecret =
  | { readonly kind: 'recovery-key'; readonly value: string }
  | { readonly kind: 'passphrase'; readonly value: string };

/** How far a write of the secret-storage pointer got; see {@link TrustEngine.setDefaultKeyPointer}. */
export interface PointerWrite {
  /** The LOCAL pointer before the write; null when unset. `raw-retry` reads nothing and reports null. */
  readonly previous: string | null;
  /**
   * The write is confirmed, or nothing needed writing. False when a `confirmed` write went
   * out but was not confirmed within its budget: it may still have landed on the server.
   */
  readonly confirmed: boolean;
}

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

  /**
   * The account's current verification on subscribe, then after each change; null when
   * there is none or the account is not live. One at a time: a request that arrives while
   * another is live is ignored. On subscribe a to-device request already in progress is
   * taken up. A replaced client is not followed: subscribe again.
   */
  verification(accountId: string): Observable<VerificationSnapshot | null>;
  /** Asks the account's other devices to verify this one. Needs a published identity. */
  requestOwnVerification(
    accountId: string,
  ): Observable<EngineResult<{ readonly flowId: string }>>;
  /**
   * Waits until `userId`'s identity reaches the crypto store, then sends the request in
   * `roomId`. Unsubscribing stops the wait; a request sent after that is cancelled.
   */
  requestUserVerification(
    accountId: string,
    userId: string,
    roomId: string,
  ): Observable<EngineResult<{ readonly flowId: string }>>;
  acceptVerification(
    accountId: string,
    flowId: string,
  ): Observable<EngineResult<null>>;
  startSas(accountId: string, flowId: string): Observable<EngineResult<null>>;
  confirmSas(accountId: string, flowId: string): Observable<EngineResult<null>>;
  mismatchSas(
    accountId: string,
    flowId: string,
  ): Observable<EngineResult<null>>;
  /** The QR payload as base64, returned once and never kept; `qr-unavailable` when empty. */
  showQr(
    accountId: string,
    flowId: string,
  ): Observable<EngineResult<{ readonly qr: string }>>;
  /**
   * Starts reciprocation with the scanned payload (base64). If the request changed while
   * scanning, the late verifier is cancelled and the result is still ok.
   */
  scanQr(
    accountId: string,
    flowId: string,
    qr: string,
  ): Observable<EngineResult<null>>;
  confirmQr(accountId: string, flowId: string): Observable<EngineResult<null>>;
  /** Cancels the verifier, then the request unless it is already over. */
  cancelVerification(
    accountId: string,
    flowId: string,
  ): Observable<EngineResult<null>>;

  /**
   * The account's devices on subscribe, then again when its device list changes here or
   * on the server. A failed read is a `request-failed` value; a replaced client is not followed.
   */
  ownDevices(accountId: string): Observable<EngineResult<readonly OwnDevice[]>>;
  renameDevice(
    accountId: string,
    deviceId: string,
    name: string,
  ): Observable<EngineResult<null>>;
  /**
   * Signs another device out. Interactive: password prompts, then one `done`; unsubscribing
   * cancels. The device this engine runs as is refused with `unsupported`.
   */
  deleteDevice(
    accountId: string,
    deviceId: string,
  ): Observable<InteractiveUpdate<null>>;
  /**
   * A harmless authenticated request, so an irreversible step can prove the person can
   * authenticate first. `done` carries the accepted password, null when none was asked for.
   */
  preAuthenticate(
    accountId: string,
  ): Observable<InteractiveUpdate<{ readonly password: string | null }>>;
  /**
   * Answers an open prompt; null cancels it (`uia-cancelled`). `prompt-gone` when no open
   * prompt of this account has `promptId`. Three rejected passwords end the command with
   * `uia-attempts-exceeded`.
   */
  answerPrompt(
    accountId: string,
    promptId: string,
    password: string | null,
  ): Observable<EngineResult<null>>;

  /**
   * How the account sees `userId` on subscribe, then after each change. A failed read is
   * reported as unverified.
   */
  userTrust(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<UserTrustFacts>>;
  /** Accepts the user's current identity, clearing `needsApproval`. */
  pinIdentity(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<null>>;
  /** Clears `wasVerified`, so a changed identity no longer needs verifying again. */
  withdrawVerification(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<null>>;

  /**
   * Unlocks the account's secret storage with `secret` and trusts this device from it,
   * then turns key backup on when it can; a backup that cannot be enabled does not fail
   * the recovery. The unlocked key stays in the engine. A `recovery-refused` failure
   * changes nothing.
   */
  recover(
    accountId: string,
    secret: RecoverySecret,
  ): Observable<EngineResult<null>>;
  /**
   * This device's room keys as a key file encrypted with `passphrase`, in the Matrix
   * key-export format other clients read. The keys never leave the engine unencrypted.
   */
  exportRoomKeys(
    accountId: string,
    passphrase: string,
  ): Observable<EngineResult<string>>;
  /**
   * Imports the room keys of a key file. `recovery-refused` (`incorrect`), importing nothing, when the
   * passphrase does not open it or it is not a key file.
   */
  importRoomKeys(
    accountId: string,
    fileText: string,
    passphrase: string,
  ): Observable<EngineResult<null>>;
  /**
   * First-device setup: a new recovery key, cross-signing (new keys when `newIdentity`, so
   * an identity this device made but never published is replaced), secret storage and a
   * new key backup, deleting every existing backup version first. Interactive: the
   * cross-signing upload may raise password prompts. `recoveryKey` is returned once and
   * never kept.
   */
  setUpRecovery(
    accountId: string,
    options: { readonly newIdentity: boolean },
  ): Observable<InteractiveUpdate<{ readonly recoveryKey: string }>>;
  /**
   * Rotates the cross-signing identity and uploads it, touching neither secret storage nor
   * the backup. Interactive; `replay` answers the first password challenge before anyone
   * is asked, and a rejected replay is not one of the three attempts. The local keys may
   * already be rotated when the upload is refused.
   */
  rotateCrossSigning(
    accountId: string,
    replay: string | null,
  ): Observable<InteractiveUpdate<null>>;
  /**
   * Writes the account's secret-storage pointer (null parks it).
   * - `confirmed`: reads the local pointer, writes nothing when it already equals `keyId`,
   *   else writes and waits for the write to be confirmed. Resolves within its own budget
   *   (Trust stops waiting after 20 s): an unconfirmed write is `confirmed: false`, not a
   *   hang. It fails only when nothing was written; once a write was attempted it reports
   *   `{previous, confirmed}`, so the caller can put `previous` back.
   * - `raw-retry`: one bare write to the server, retried through dropped connections, with
   *   no read before it (the local store can lag the server either way).
   */
  setDefaultKeyPointer(
    accountId: string,
    keyId: string | null,
    mode: 'confirmed' | 'raw-retry',
  ): Observable<EngineResult<PointerWrite>>;
  /** Deletes the account's dehydrated device (MSC3814); fails when there is none. */
  deleteDehydratedDevice(accountId: string): Observable<EngineResult<null>>;
  /**
   * A new secret-storage key holding the cross-signing keys, and a new key backup under
   * it, after deleting EVERY existing backup version. `recoveryKey` is returned once.
   */
  createRecoveryAndBackup(
    accountId: string,
  ): Observable<EngineResult<{ readonly recoveryKey: string }>>;
  /** Drops the description of secret-storage key `keyId`, unless it is still the local default. */
  dropKeyDescription(
    accountId: string,
    keyId: string,
  ): Observable<EngineResult<null>>;
}
