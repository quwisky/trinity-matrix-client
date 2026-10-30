import type { Observable } from 'rxjs';
import type {
  AccountStartFailureReason,
  EngineFailure,
  EngineResult,
  MatrixSession,
  UiaAuth,
} from '@trinity/util/matrix';

export type PersistedAccountActivation = 'activate' | 'background';

/** What the homeserver says about one account's token: accepted, refused as gone, or no answer. */
export type AccountServerStatus = 'active' | 'gone' | 'unreachable';

/**
 * One account's sync state: js-sdk's six states, plus `starting` for a live account before its
 * first transition. A Rust engine maps `SyncService` Idle to `starting` or `stopped`, Running to
 * `syncing`, Offline to `reconnecting`, Error to `error` and Terminated to `stopped`; a room list
 * loaded from cache is `prepared`, and `catchup` goes unused.
 */
export type SessionSyncState =
  | 'starting'
  | 'prepared'
  | 'syncing'
  | 'catchup'
  | 'reconnecting'
  | 'error'
  | 'stopped';

export interface SessionAccountStatus {
  readonly accountId: string;
  /** This device's id; null while the client has none. */
  readonly deviceId: string | null;
  /** An engine-wide count that grows by one for each client registered, for any account. */
  readonly generation: number;
  readonly syncState: SessionSyncState;
  /** Whether the live client has completed a sync with its homeserver, not only its cache. */
  readonly serverSynced: boolean;
  /** Whether the live client has prepared its rooms, from its cache or its homeserver. */
  readonly roomsPrepared: boolean;
  /** How many of its messages wait to be sent by themselves. */
  readonly waitingCount: number;
  readonly cryptoStoreEncrypted: boolean;
}

export interface SessionSnapshot {
  readonly activeAccountId: string | null;
  /** Live accounts in registry order. */
  readonly accounts: readonly SessionAccountStatus[];
  /** Accounts that need a sign-in again; their stores and registry entries are kept. */
  readonly softLoggedOut: readonly string[];
}

export const EMPTY_SESSION: SessionSnapshot = {
  activeAccountId: null,
  accounts: [],
  softLoggedOut: [],
};

export interface SessionAccessToken {
  /** The homeserver the token is for. Rust: `Client::homeserver()`. */
  readonly homeserverUrl: string;
  readonly accessToken: string;
  /** Epoch ms; null when the server gave no lifetime, and for password and SSO tokens. */
  readonly expiresAt: number | null;
  readonly refreshable: boolean;
}

/** A live session's own tokens, read once so they can end it after its client is gone. */
export interface SessionCredentials {
  readonly accessToken: string;
  /** Null for a session without one, such as a password or SSO session. */
  readonly refreshToken: string | null;
}

/** What a hold on one account's hard-logout wipe reports, `held` first. */
export type ServerLogoutHoldUpdate =
  | {
      readonly kind: 'held';
      readonly holdId: string;
      /** Whether the server had already revoked the token when the hold was taken. */
      readonly tokenDied: boolean;
    }
  /** The server revoked the token: the client stopped and nothing was wiped. */
  | { readonly kind: 'token-died' }
  /** A new client replaced the one whose token died. */
  | { readonly kind: 'token-renewed' }
  /** A sign-in after a soft logout succeeded, which a deleted account cannot do. */
  | { readonly kind: 'signed-in-again' }
  /** The account left this device and took its holds with it; the stream completes. */
  | { readonly kind: 'released' };

/** A text message a live client has not got onto the homeserver. */
export interface PendingTextMessage {
  readonly accountId: string;
  readonly roomId: string;
  /** The thread it replies in, or null for the room's main timeline. */
  readonly threadRootId: string | null;
  /** What to put back in the composer: the plain body, the composer's own markdown source. */
  readonly text: string;
  /** Names the echo's waiting-to-send record in the draft store, which this text supersedes. */
  readonly txnId?: string;
}

/** Names one source knows: the account itself, or one room. */
export interface AccountNameGroup {
  readonly roomNames: readonly string[];
  readonly roomTopics: readonly string[];
  readonly displayNames: readonly string[];
}

/** `offline` once sync is erroring or reconnecting, else `online`, so a fresh start never flashes offline. */
export function connectivityOf(
  state: SessionSyncState | null,
): 'online' | 'offline' {
  return state === 'error' || state === 'reconnecting' ? 'offline' : 'online';
}

/** Why a persisted account could not start, when the failure is one. */
export function accountStartFailureReason(
  failure: EngineFailure,
): AccountStartFailureReason | null {
  return failure.code === 'account-start-failed' ? failure.params.reason : null;
}

/**
 * The signed-in accounts and their lifecycle. Commands are cold, emit once and complete; void
 * commands emit `null`. A command's effect is in the next `session()` snapshot before it emits.
 */
export interface SessionEngine {
  /** The current snapshot on subscribe, then each change. Never carries a token. */
  session(): Observable<SessionSnapshot>;
  /** The live client's token on subscribe and after each change, or null when none is live. */
  accessToken(accountId: string): Observable<SessionAccessToken | null>;
  /**
   * Starts a persisted account. It also adopts a pending QR session for the same user and
   * device, and the secrets that session received.
   */
  restorePersisted(
    session: MatrixSession,
    activation: PersistedAccountActivation,
  ): Observable<EngineResult<null>>;
  requireReauthentication(accountId: string): Observable<null>;
  activateAccount(
    accountId: string,
    liveAccounts: 'keep' | 'replace',
  ): Observable<EngineResult<null>>;
  rollbackAccountStart(accountId: string): Observable<null>;
  setActive(accountId: string): Observable<null>;
  remove(accountId: string): Observable<null>;
  stop(): Observable<null>;
  signOutAll(): Observable<null>;
  pauseSync(): Observable<null>;
  hasOutgoingWork(): Observable<boolean>;
  pendingTextMessages(): Observable<readonly PendingTextMessage[]>;
  refreshAccessToken(
    accountId: string,
    options: { readonly timeoutMs?: number },
  ): Observable<boolean>;
  accountStatus(accountId: string): Observable<AccountServerStatus>;
  roomKeysBackedUp(accountId: string): Observable<boolean | null>;
  /**
   * Holds back one account's hard-logout wipe while subscribed: a non-soft `M_UNKNOWN_TOKEN`
   * then only stops its client. `token-died` reaches the subscriber before the result of any
   * engine request that met the dead token. Unsubscribing releases the hold as not deleted.
   */
  holdServerLogout(accountId: string): Observable<ServerLogoutHoldUpdate>;
  /**
   * Ends a hold and completes its stream; an unknown id is ignored. `deleted: true` leaves
   * the account to the deletion cleanup, `false` replays a recorded logout's wipe.
   */
  releaseServerLogoutHold(holdId: string, deleted: boolean): Observable<null>;
  /** `POST /account/deactivate` with the live client; `uia-required` carries the challenge. */
  deactivateAccount(
    accountId: string,
    erase: boolean,
    auth: UiaAuth | null,
  ): Observable<EngineResult<null>>;
  /** Ends the live session at its homeserver, or at its provider for OAuth, and stops it. */
  logoutRemote(accountId: string): Observable<EngineResult<null>>;
  /**
   * Ends a session that is not live the same way, without starting it or saving a refresh. It
   * also ends and forgets a pending QR session for that user and device.
   */
  logoutSession(session: MatrixSession): Observable<EngineResult<null>>;
  /**
   * The live client's tokens, or null when none is live. Only for credentials that must outlive
   * the client; never logged or put in a failure.
   */
  liveCredentials(accountId: string): Observable<SessionCredentials | null>;
  /**
   * The account's own display name, then each room's name, topic and members' display names
   * (joined, invited, left and banned), from what the engine already holds; nothing is fetched.
   */
  knownNames(
    accountId: string,
  ): Observable<EngineResult<readonly AccountNameGroup[]>>;
}
