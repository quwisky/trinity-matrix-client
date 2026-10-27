import { Injectable, type Signal, computed, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { SyncState } from 'matrix-js-sdk';
import {
  type Observable,
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
  type EngineResult,
  type MatrixSession,
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import { MatrixClientStartupError } from '../account-start-failure';
import type {
  AccountServerStatus,
  PendingTextMessage,
  PersistedAccountActivation,
  SessionAccessToken,
  SessionAccountStatus,
  SessionEngine,
  SessionSnapshot,
  SessionSyncState,
} from '../session-engine';
import { MatrixClientService } from './matrix-client.service';

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

/** {@link SessionEngine} over the live matrix-js-sdk clients of {@link MatrixClientService}. */
@Injectable({ providedIn: 'root' })
export class JsSdkSessionEngine implements SessionEngine {
  private readonly svc = inject(MatrixClientService);

  private readonly accounts = computed(
    (): readonly SessionAccountStatus[] => {
      const ids = this.svc.accountIds();
      const generations = this.svc.sessionGenerations();
      const clients = new Map(this.svc.all().map((a) => [a.userId, a]));
      return ids.flatMap((accountId) => {
        const account = clients.get(accountId);
        return account
          ? [
              {
                accountId,
                generation: generations.get(accountId) ?? 0,
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
}
