import { Injectable, type Signal, computed, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { MatrixError, type MatrixClient, SyncState } from 'matrix-js-sdk';
import {
  Observable,
  type Subscriber,
  catchError,
  concat,
  defer,
  distinctUntilChanged,
  filter,
  map,
  merge,
  of,
  startWith,
  throwError,
} from 'rxjs';
import {
  type EngineFailure,
  type EngineResult,
  type MatrixSession,
  type UiaAuth,
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import { MatrixClientStartupError } from '../account-start-failure';
import type {
  AccountNameGroup,
  AccountServerStatus,
  PendingTextMessage,
  PersistedAccountActivation,
  ServerLogoutHoldUpdate,
  SessionAccessToken,
  SessionAccountStatus,
  SessionCredentials,
  SessionEngine,
  SessionSnapshot,
  SessionStorageEffect,
  SessionSyncState,
} from '../session-engine';
import type { ServerLogoutHold } from '../server-logout-hold';
import { accountKnownNames } from './known-names';
import { MatrixClientService } from './matrix-client.service';
import { uiaChallengeOf } from './uia';

const SYNC_STATES: Readonly<Record<SyncState, SessionSyncState>> = {
  [SyncState.Prepared]: 'prepared',
  [SyncState.Syncing]: 'syncing',
  [SyncState.Catchup]: 'catchup',
  [SyncState.Reconnecting]: 'reconnecting',
  [SyncState.Error]: 'error',
  [SyncState.Stopped]: 'stopped',
};

export function toSessionSyncState(state: SyncState | null): SessionSyncState {
  return state === null ? 'starting' : SYNC_STATES[state];
}

const ACCOUNT_NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

/**
 * A failed request as a result: a UIA challenge, a missing endpoint (`M_UNRECOGNIZED`, or a
 * Matrix 404/405 that is not `M_NOT_FOUND`), a policy refusal (`M_FORBIDDEN`), or else
 * `request-failed`, marked `session-refresh` when a token refresh failed first. Only the
 * allowlisted diagnostic crosses.
 */
function requestFailure(error: unknown): EngineResult<never> {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  const challenge = uiaChallengeOf(error);
  if (challenge) {
    return engineFail({
      kind,
      diagnostic,
      code: 'uia-required',
      params: { challenge },
    });
  }
  if (!(error instanceof MatrixError)) {
    return engineFail({
      kind,
      diagnostic,
      code: 'request-failed',
      ...(diagnostic.errorName === 'TokenRefreshError'
        ? { params: { cause: 'session-refresh' as const } }
        : {}),
    });
  }
  const missing =
    error.errcode === 'M_UNRECOGNIZED' ||
    ((error.httpStatus === 404 || error.httpStatus === 405) &&
      error.errcode !== 'M_NOT_FOUND');
  const code = missing
    ? 'unsupported'
    : error.errcode === 'M_FORBIDDEN'
      ? 'forbidden'
      : 'request-failed';
  return engineFail({ kind, diagnostic, code });
}

async function settle(
  request: () => Promise<unknown>,
): Promise<EngineResult<null>> {
  try {
    await request();
    return engineOk(null);
  } catch (error: unknown) {
    return requestFailure(error);
  }
}

/** {@link SessionEngine} over the live matrix-js-sdk clients of {@link MatrixClientService}. */
@Injectable({ providedIn: 'root' })
export class JsSdkSessionEngine implements SessionEngine {
  private readonly svc = inject(MatrixClientService);
  private readonly holds = new Map<
    string,
    {
      readonly hold: ServerLogoutHold;
      readonly subscriber: Subscriber<ServerLogoutHoldUpdate>;
    }
  >();
  private holdCount = 0;

  private readonly accounts = computed(
    (): readonly SessionAccountStatus[] => {
      // A new array on every registration, so a same-id re-add is seen too.
      const ids = this.svc.accountIds();
      const clients = new Map(this.svc.all().map((a) => [a.userId, a]));
      return ids.flatMap((accountId) => {
        const account = clients.get(accountId);
        return account
          ? [
              {
                accountId,
                deviceId: account.client.getDeviceId(),
                generation: account.generation,
                syncState: toSessionSyncState(account.syncState()),
                serverSynced: account.serverSynced(),
                roomsPrepared: account.roomsPrepared(),
                waitingCount: account.waitingCount(),
                cryptoStoreEncrypted: account.cryptoStoreEncrypted,
              },
            ]
          : [];
      });
    },
    { equal: plainEqual },
  );

  /** One effect for the engine's lifetime; replays may be stale, so readers re-read {@link snapshot}. */
  private readonly snapshots$: Observable<unknown>;

  /** Synchronous: a command's effect is here as soon as the command has run. */
  readonly snapshot: Signal<SessionSnapshot> = computed(
    () => ({
      activeAccountId: this.svc.activeUserId(),
      accounts: this.accounts(),
      softLoggedOut: this.svc.softLoggedOut(),
    }),
    { equal: plainEqual },
  );

  constructor() {
    this.snapshots$ = toObservable(this.snapshot);
  }

  session(): Observable<SessionSnapshot> {
    return defer(() =>
      concat(
        of(this.snapshot()),
        this.snapshots$.pipe(map(() => this.snapshot())),
      ),
    ).pipe(distinctUntilChanged<SessionSnapshot>(plainEqual));
  }

  storageEffects(): Observable<SessionStorageEffect> {
    return this.svc.storageEffects;
  }

  accessToken(accountId: string): Observable<SessionAccessToken | null> {
    return merge(
      this.snapshots$,
      this.svc.accessTokenRotations.pipe(
        filter((rotation) => rotation.userId === accountId),
      ),
    ).pipe(
      startWith(null),
      map(() => this.svc.accessTokenState(accountId)),
      distinctUntilChanged<SessionAccessToken | null>(plainEqual),
    );
  }

  restorePersisted(
    session: MatrixSession,
    activation: PersistedAccountActivation,
  ): Observable<EngineResult<null>> {
    return this.svc.startPersisted(session, activation).pipe(
      map((): EngineResult<null> => engineOk(null)),
      catchError((error: unknown) => {
        if (!(error instanceof MatrixClientStartupError)) {
          return throwError(() => error);
        }
        const { kind, diagnostic } = describeMatrixRequestFailure(
          error.original,
        );
        return of(
          engineFail({
            kind,
            diagnostic,
            code: 'account-start-failed',
            params: { reason: error.failure },
          }),
        );
      }),
    );
  }

  requireReauthentication(accountId: string): Observable<null> {
    return defer(() => {
      this.svc.requireReauthentication(accountId);
      return of(null);
    });
  }

  activateAccount(
    accountId: string,
    liveAccounts: 'keep' | 'replace',
  ): Observable<EngineResult<null>> {
    return defer(() => {
      if (!this.svc.clientFor(accountId)) {
        return of(
          engineFail({
            kind: 'unexpected',
            code: 'account-not-live',
            diagnostic: { kind: 'unexpected' },
          }),
        );
      }
      this.svc.activateAccount(accountId, liveAccounts);
      return of(engineOk(null));
    });
  }

  rollbackAccountStart(accountId: string): Observable<null> {
    return defer(() => this.svc.rollbackAccountStart(accountId)).pipe(
      map(() => null),
    );
  }

  setActive(accountId: string): Observable<null> {
    return defer(() => {
      this.svc.setActive(accountId);
      return of(null);
    });
  }

  remove(accountId: string): Observable<null> {
    return defer(() => this.svc.remove(accountId)).pipe(map(() => null));
  }

  stop(): Observable<null> {
    return defer(() => this.svc.stop()).pipe(map(() => null));
  }

  signOutAll(): Observable<null> {
    return defer(() => this.svc.signOutAll()).pipe(map(() => null));
  }

  pauseSync(): Observable<null> {
    return defer(() => {
      this.svc.pauseSync();
      return of(null);
    });
  }

  hasOutgoingWork(): Observable<boolean> {
    return defer(() => of(this.svc.hasOutgoingWork()));
  }

  pendingTextMessages(): Observable<readonly PendingTextMessage[]> {
    return defer(() => of(this.svc.pendingTextMessages()));
  }

  refreshAccessToken(
    accountId: string,
    options: { readonly timeoutMs?: number },
  ): Observable<boolean> {
    return this.svc.refreshAccessToken(accountId, options);
  }

  accountStatus(accountId: string): Observable<AccountServerStatus> {
    return this.svc.accountStatus(accountId);
  }

  roomKeysBackedUp(accountId: string): Observable<boolean | null> {
    return this.svc.roomKeysBackedUp(accountId);
  }

  holdServerLogout(accountId: string): Observable<ServerLogoutHoldUpdate> {
    return new Observable<ServerLogoutHoldUpdate>((subscriber) => {
      const holdId = String(++this.holdCount);
      // Facts arrive synchronously from the SDK's logout event, which it emits before the
      // failing request rejects: so `token-died` precedes that request's result.
      const hold = this.svc.holdServerLogout(accountId, (fact) => {
        subscriber.next({ kind: fact });
        if (fact === 'released') subscriber.complete();
      });
      this.holds.set(holdId, { hold, subscriber });
      subscriber.next({ kind: 'held', holdId, tokenDied: hold.tokenDied() });
      return () => this.releaseHold(holdId, false);
    });
  }

  releaseServerLogoutHold(holdId: string, deleted: boolean): Observable<null> {
    return defer(() => {
      this.releaseHold(holdId, deleted);
      return of(null);
    });
  }

  deactivateAccount(
    accountId: string,
    erase: boolean,
    auth: UiaAuth | null,
  ): Observable<EngineResult<null>> {
    return this.withClient(accountId, (client) =>
      client.deactivateAccount(auth ?? undefined, erase),
    );
  }

  logoutRemote(accountId: string): Observable<EngineResult<null>> {
    return this.withClient(accountId, (client) => client.logout(true));
  }

  logoutSession(session: MatrixSession): Observable<EngineResult<null>> {
    // A refresh on a device being signed out must never overwrite the stored tokens.
    return defer(() => {
      this.svc.dropLinkedSecrets(session.userId, session.deviceId);
      return settle(() =>
        this.svc
          .detachedClient(session, { persistRefreshedTokens: false })
          .logout(true),
      );
    });
  }

  liveCredentials(accountId: string): Observable<SessionCredentials | null> {
    return defer(() => {
      const client = this.svc.clientFor(accountId);
      const token = this.svc.accessTokenState(accountId);
      return of(
        client && token
          ? {
              accessToken: token.accessToken,
              refreshToken: client.getRefreshToken(),
            }
          : null,
      );
    });
  }

  knownNames(
    accountId: string,
  ): Observable<EngineResult<readonly AccountNameGroup[]>> {
    return defer(() => {
      const client = this.svc.clientFor(accountId);
      return of(
        client
          ? engineOk(accountKnownNames(client))
          : engineFail(ACCOUNT_NOT_LIVE),
      );
    });
  }

  private withClient(
    accountId: string,
    request: (client: MatrixClient) => Promise<unknown>,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      const client = this.svc.clientFor(accountId);
      return client
        ? settle(() => request(client))
        : of(engineFail(ACCOUNT_NOT_LIVE));
    });
  }

  private releaseHold(holdId: string, deleted: boolean): void {
    const entry = this.holds.get(holdId);
    if (!entry) return;
    this.holds.delete(holdId);
    entry.hold.release({ deleted });
    entry.subscriber.complete();
  }
}
