import {
  BehaviorSubject,
  type Observable,
  defer,
  distinctUntilChanged,
  map,
  of,
} from 'rxjs';
import {
  type AccountStartFailureReason,
  type EngineResult,
  type MatrixSession,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import {
  type AccountServerStatus,
  EMPTY_SESSION,
  type PendingTextMessage,
  type PersistedAccountActivation,
  type SessionAccessToken,
  type SessionAccountStatus,
  type SessionEngine,
  type SessionSnapshot,
} from '../lib/session-engine';

/** In-memory accounts with scripted start failures, sync progress and token rotation. */
export class FakeSessionEngine implements SessionEngine {
  private readonly snapshot$ = new BehaviorSubject<SessionSnapshot>(
    EMPTY_SESSION,
  );
  private readonly tokens$ = new BehaviorSubject<
    ReadonlyMap<string, SessionAccessToken>
  >(new Map());
  private readonly startFailures = new Map<string, AccountStartFailureReason>();
  private readonly serverStatuses = new Map<string, AccountServerStatus>();
  private readonly backedUp = new Map<string, boolean | null>();
  private generation = 0;
  private outgoingWork = false;
  private outgoingTexts: readonly PendingTextMessage[] = [];

  readonly calls: string[] = [];
  /** Tokens `signOutAll` has revoked, for the contract's `tokenAccepted`. */
  readonly revokedTokens = new Set<string>();

  failStart(accountId: string, reason: AccountStartFailureReason): void {
    this.startFailures.set(accountId, reason);
  }

  sync(
    accountId: string,
    patch: Partial<Omit<SessionAccountStatus, 'accountId' | 'generation'>>,
  ): void {
    this.update((s) => ({
      ...s,
      accounts: s.accounts.map((a) =>
        a.accountId === accountId ? { ...a, ...patch } : a,
      ),
    }));
  }

  setToken(accountId: string, token: SessionAccessToken | null): void {
    const next = new Map(this.tokens$.value);
    if (token) next.set(accountId, token);
    else next.delete(accountId);
    this.tokens$.next(next);
  }

  setServerStatus(accountId: string, status: AccountServerStatus): void {
    this.serverStatuses.set(accountId, status);
  }

  setBackedUp(accountId: string, value: boolean | null): void {
    this.backedUp.set(accountId, value);
  }

  setOutgoing(work: boolean, texts: readonly PendingTextMessage[]): void {
    this.outgoingWork = work;
    this.outgoingTexts = texts;
  }

  session(): Observable<SessionSnapshot> {
    return this.snapshot$.pipe(
      distinctUntilChanged<SessionSnapshot>(plainEqual),
    );
  }

  accessToken(accountId: string): Observable<SessionAccessToken | null> {
    return this.tokens$.pipe(
      map((tokens) => tokens.get(accountId) ?? null),
      distinctUntilChanged<SessionAccessToken | null>(plainEqual),
    );
  }

  restorePersisted(
    session: MatrixSession,
    activation: PersistedAccountActivation,
  ): Observable<EngineResult<null>> {
    return this.run(`restorePersisted:${session.userId}`, () => {
      const accountId = session.userId;
      const reason = this.startFailures.get(accountId);
      if (reason) {
        this.startFailures.delete(accountId);
        if (reason === 'reauthentication-required') {
          this.update((s) => ({
            ...s,
            softLoggedOut: [...new Set([...s.softLoggedOut, accountId])],
          }));
        }
        return engineFail({
          kind: 'unexpected',
          code: 'account-start-failed',
          diagnostic: { kind: 'unexpected' },
          params: { reason },
        });
      }
      this.generation += 1;
      const status: SessionAccountStatus = {
        accountId,
        generation: this.generation,
        syncState: 'syncing',
        serverSynced: true,
        roomsPrepared: true,
        waitingCount: 0,
        cryptoStoreEncrypted: true,
      };
      this.setToken(accountId, {
        accessToken: session.accessToken,
        expiresAt: session.accessTokenExpiresAt ?? null,
        refreshable: session.refreshToken !== undefined,
      });
      this.update((s) => ({
        activeAccountId:
          activation === 'activate' ? accountId : s.activeAccountId,
        accounts: [
          ...s.accounts.filter((a) => a.accountId !== accountId),
          status,
        ],
        softLoggedOut: s.softLoggedOut.filter((id) => id !== accountId),
      }));
      return engineOk(null);
    });
  }

  requireReauthentication(accountId: string): Observable<null> {
    return this.run(`requireReauthentication:${accountId}`, () => {
      this.drop(accountId);
      this.update((s) => ({
        ...s,
        softLoggedOut: [...new Set([...s.softLoggedOut, accountId])],
      }));
      return null;
    });
  }

  activateAccount(
    accountId: string,
    liveAccounts: 'keep' | 'replace',
  ): Observable<EngineResult<null>> {
    return this.run(`activateAccount:${accountId}`, () => {
      if (!this.isLive(accountId)) {
        return engineFail({
          kind: 'unexpected',
          code: 'account-not-live',
          diagnostic: { kind: 'unexpected' },
        });
      }
      if (liveAccounts === 'replace') {
        for (const a of this.snapshot$.value.accounts) {
          if (a.accountId !== accountId) this.drop(a.accountId);
        }
      }
      this.update((s) => ({ ...s, activeAccountId: accountId }));
      return engineOk(null);
    });
  }

  rollbackAccountStart(accountId: string): Observable<null> {
    return this.run(`rollbackAccountStart:${accountId}`, () => {
      this.drop(accountId);
      return null;
    });
  }

  setActive(accountId: string): Observable<null> {
    return this.run(`setActive:${accountId}`, () => {
      if (this.isLive(accountId)) {
        this.update((s) => ({ ...s, activeAccountId: accountId }));
      }
      return null;
    });
  }

  remove(accountId: string): Observable<null> {
    return this.run(`remove:${accountId}`, () => {
      this.drop(accountId);
      this.update((s) => ({
        ...s,
        softLoggedOut: s.softLoggedOut.filter((id) => id !== accountId),
      }));
      return null;
    });
  }

  stop(): Observable<null> {
    return this.run('stop', () => {
      this.snapshot$.next(EMPTY_SESSION);
      this.tokens$.next(new Map());
      return null;
    });
  }

  signOutAll(): Observable<null> {
    return this.run('signOutAll', () => {
      for (const token of this.tokens$.value.values()) {
        this.revokedTokens.add(token.accessToken);
      }
      this.snapshot$.next(EMPTY_SESSION);
      this.tokens$.next(new Map());
      return null;
    });
  }

  pauseSync(): Observable<null> {
    return this.run('pauseSync', () => null);
  }

  hasOutgoingWork(): Observable<boolean> {
    return this.run('hasOutgoingWork', () => this.outgoingWork);
  }

  pendingTextMessages(): Observable<readonly PendingTextMessage[]> {
    return this.run('pendingTextMessages', () => this.outgoingTexts);
  }

  refreshAccessToken(
    accountId: string,
    options: { readonly timeoutMs?: number },
  ): Observable<boolean> {
    return this.run(`refreshAccessToken:${accountId}`, () => {
      void options;
      return false;
    });
  }

  accountStatus(accountId: string): Observable<AccountServerStatus> {
    return this.run(
      `accountStatus:${accountId}`,
      () =>
        this.serverStatuses.get(accountId) ??
        (this.isLive(accountId) ? 'active' : 'unreachable'),
    );
  }

  roomKeysBackedUp(accountId: string): Observable<boolean | null> {
    return this.run(
      `roomKeysBackedUp:${accountId}`,
      () => this.backedUp.get(accountId) ?? null,
    );
  }

  private run<T>(call: string, action: () => T): Observable<T> {
    return defer(() => {
      this.calls.push(call);
      return of(action());
    });
  }

  private isLive(accountId: string): boolean {
    return this.snapshot$.value.accounts.some((a) => a.accountId === accountId);
  }

  private update(change: (s: SessionSnapshot) => SessionSnapshot): void {
    this.snapshot$.next(change(this.snapshot$.value));
  }

  /** Retires a live account and repoints the active one to the first that remains. */
  private drop(accountId: string): void {
    this.setToken(accountId, null);
    this.update((s) => {
      const accounts = s.accounts.filter((a) => a.accountId !== accountId);
      return {
        ...s,
        accounts,
        activeAccountId:
          s.activeAccountId === accountId
            ? (accounts[0]?.accountId ?? null)
            : s.activeAccountId,
      };
    });
  }
}
