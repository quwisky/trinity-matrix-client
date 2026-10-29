import type { Observable } from 'rxjs';
import type {
  AccountStartFailureReason,
  EngineFailure,
  EngineResult,
  MatrixSession,
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
  /** Grows each time a new client is registered for the account. */
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
}
