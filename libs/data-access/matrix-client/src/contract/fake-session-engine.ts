import {
  BehaviorSubject,
  Observable,
  type Subscriber,
  defer,
  distinctUntilChanged,
  finalize,
  from,
  map,
  of,
  shareReplay,
  tap,
} from 'rxjs';
import {
  type AccountStartFailureReason,
  type EngineFailure,
  type EngineResult,
  type MatrixSession,
  type UiaAuth,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import {
  type AccountNameGroup,
  type AccountServerStatus,
  EMPTY_SESSION,
  type PendingTextMessage,
  type PersistedAccountActivation,
  type ServerLogoutHoldUpdate,
  type SessionAccessToken,
  type SessionAccountStatus,
  type SessionCredentials,
  type SessionEngine,
  type SessionSnapshot,
} from '../lib/session-engine';

/** The request-failure kind the js-sdk adapter reports for each start failure reason. */
const START_FAILURE_KIND = {
  'reauthentication-required': 'authentication',
  'transient-network': 'network',
  'crypto-failure': 'unexpected',
  'crypto-store-key-lost': 'unexpected',
  'secure-storage-unavailable': 'unexpected',
} as const satisfies Record<AccountStartFailureReason, string>;

const NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

const UNKNOWN_TOKEN: EngineFailure = {
  kind: 'authentication',
  code: 'request-failed',
  diagnostic: {
    kind: 'authentication',
    httpStatus: 401,
    errcode: 'M_UNKNOWN_TOKEN',
  },
};

interface FakeHold {
  readonly accountId: string;
  readonly subscriber: Subscriber<ServerLogoutHoldUpdate>;
}

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
  private readonly refreshTokens = new Map<string, string>();
  private readonly holds = new Map<string, FakeHold>();
  private readonly names = new Map<string, readonly AccountNameGroup[]>();
  private readonly starting = new Map<string, Observable<EngineResult<null>>>();
  /** Accounts whose token died while held, kept live until the hold ends. */
  private readonly diedWhileHeld = new Set<string>();
  /** Held accounts a holder released as deleted, which keeps a recorded death from wiping. */
  private readonly releasedAsDeleted = new Set<string>();
  private generation = 0;
  private holdCount = 0;
  private outgoingWork = false;
  private outgoingTexts: readonly PendingTextMessage[] = [];

  readonly calls: string[] = [];
  /** Tokens the server no longer accepts, for the contract's `tokenAccepted`. */
  readonly revokedTokens = new Set<string>();
  /** The password `deactivateAccount` accepts for every account. */
  readonly password = 'fake-password';

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

  /** The server soft-logs the account out: its client stops and leaves the snapshot. */
  softLogout(accountId: string): void {
    this.drop(accountId);
    this.update((s) => ({
      ...s,
      softLoggedOut: [...new Set([...s.softLoggedOut, accountId])],
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

  /** What the account's engine holds, kept across restarts as a server would. */
  addKnownNames(accountId: string, group: AccountNameGroup): void {
    this.names.set(accountId, [...(this.names.get(accountId) ?? []), group]);
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
    const accountId = session.userId;
    return defer(() => {
      this.calls.push(`restorePersisted:${accountId}`);
      let started = this.starting.get(accountId);
      if (!started) {
        const shared: Observable<EngineResult<null>> = from(
          Promise.resolve(),
        ).pipe(
          map(() => this.start(session)),
          finalize(() => {
            if (this.starting.get(accountId) === shared) {
              this.starting.delete(accountId);
            }
          }),
          shareReplay({ bufferSize: 1, refCount: false }),
        );
        this.starting.set(accountId, shared);
        started = shared;
      }
      return started.pipe(
        tap((result) => {
          if (result.ok && activation === 'activate') {
            this.update((s) => ({ ...s, activeAccountId: accountId }));
          }
        }),
      );
    });
  }

  requireReauthentication(accountId: string): Observable<null> {
    return this.run(`requireReauthentication:${accountId}`, () => {
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
      this.leave(accountId);
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
      for (const accountId of this.snapshot$.value.accounts.map(
        (a) => a.accountId,
      )) {
        this.leave(accountId);
      }
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
    return this.run(`accountStatus:${accountId}`, () => {
      const scripted = this.serverStatuses.get(accountId);
      if (scripted) return scripted;
      const whoami = this.request(accountId, () => engineOk(null));
      if (whoami.ok) return 'active';
      return whoami.failure.code === 'account-not-live'
        ? 'unreachable'
        : 'gone';
    });
  }

  roomKeysBackedUp(accountId: string): Observable<boolean | null> {
    return this.run(
      `roomKeysBackedUp:${accountId}`,
      () => this.backedUp.get(accountId) ?? null,
    );
  }

  holdServerLogout(accountId: string): Observable<ServerLogoutHoldUpdate> {
    return new Observable<ServerLogoutHoldUpdate>((subscriber) => {
      this.calls.push(`holdServerLogout:${accountId}`);
      const holdId = `hold-${++this.holdCount}`;
      this.holds.set(holdId, { accountId, subscriber });
      subscriber.next({
        kind: 'held',
        holdId,
        tokenDied: this.diedWhileHeld.has(accountId),
      });
      return () => this.release(holdId, false);
    });
  }

  releaseServerLogoutHold(holdId: string, deleted: boolean): Observable<null> {
    return this.run(`releaseServerLogoutHold:${holdId}:${deleted}`, () => {
      this.release(holdId, deleted);
      return null;
    });
  }

  deactivateAccount(
    accountId: string,
    erase: boolean,
    auth: UiaAuth | null,
  ): Observable<EngineResult<null>> {
    return this.run(`deactivateAccount:${accountId}:${erase}`, () =>
      this.request(accountId, () => {
        const password = auth && 'password' in auth ? auth.password : null;
        if (password !== this.password) {
          return engineFail({
            kind: 'http',
            code: 'uia-required',
            diagnostic: { kind: 'http', httpStatus: 401 },
            params: {
              challenge: {
                flows: [{ stages: ['m.login.password'] }],
                session: 'fake-uia',
                completed: [],
              },
            },
          });
        }
        this.revoke(accountId);
        // The account's own sync then meets the revoked token.
        this.tokenDied(accountId);
        return engineOk(null);
      }),
    );
  }

  logoutRemote(accountId: string): Observable<EngineResult<null>> {
    return this.run(`logoutRemote:${accountId}`, () =>
      this.request(accountId, () => {
        this.revoke(accountId);
        return engineOk(null);
      }),
    );
  }

  logoutSession(session: MatrixSession): Observable<EngineResult<null>> {
    return this.run(`logoutSession:${session.userId}`, () => {
      if (this.revokedTokens.has(session.accessToken)) {
        return engineFail(UNKNOWN_TOKEN);
      }
      this.revokedTokens.add(session.accessToken);
      return engineOk(null);
    });
  }

  liveCredentials(accountId: string): Observable<SessionCredentials | null> {
    return this.run(`liveCredentials:${accountId}`, () => {
      const token = this.tokens$.value.get(accountId);
      return token
        ? {
            accessToken: token.accessToken,
            refreshToken: this.refreshTokens.get(accountId) ?? null,
          }
        : null;
    });
  }

  knownNames(
    accountId: string,
  ): Observable<EngineResult<readonly AccountNameGroup[]>> {
    return this.run(`knownNames:${accountId}`, () =>
      this.isLive(accountId)
        ? engineOk(this.names.get(accountId) ?? [])
        : engineFail(NOT_LIVE),
    );
  }

  /** Registers a new client for the account, leaving its activation to each caller. */
  private start(session: MatrixSession): EngineResult<null> {
    const accountId = session.userId;
    const reason = this.startFailures.get(accountId);
    if (reason) {
      this.startFailures.delete(accountId);
      if (
        reason === 'reauthentication-required' ||
        reason === 'crypto-store-key-lost'
      ) {
        this.update((s) => ({
          ...s,
          softLoggedOut: [...new Set([...s.softLoggedOut, accountId])],
        }));
      }
      const kind = START_FAILURE_KIND[reason];
      return engineFail({
        kind,
        code: 'account-start-failed',
        diagnostic: { kind },
        params: { reason },
      });
    }
    this.generation += 1;
    if (session.refreshToken) {
      this.refreshTokens.set(accountId, session.refreshToken);
    } else {
      this.refreshTokens.delete(accountId);
    }
    const signedInAgain =
      this.snapshot$.value.softLoggedOut.includes(accountId);
    const status: SessionAccountStatus = {
      accountId,
      deviceId: session.deviceId,
      generation: this.generation,
      syncState: 'syncing',
      serverSynced: true,
      roomsPrepared: true,
      waitingCount: 0,
      cryptoStoreEncrypted: true,
    };
    this.setToken(accountId, {
      homeserverUrl: session.baseUrl,
      accessToken: session.accessToken,
      expiresAt: session.oidc ? (session.accessTokenExpiresAt ?? null) : null,
      refreshable: !!session.oidc && !!session.refreshToken,
    });
    this.update((s) => ({
      ...s,
      accounts: [
        ...s.accounts.filter((a) => a.accountId !== accountId),
        status,
      ],
      softLoggedOut: s.softLoggedOut.filter((id) => id !== accountId),
    }));
    // As the SDK adapter does: a recorded death belonged to the replaced client.
    if (this.diedWhileHeld.delete(accountId)) {
      this.tell(accountId, { kind: 'token-renewed' });
    }
    if (signedInAgain) this.tell(accountId, { kind: 'signed-in-again' });
    return engineOk(null);
  }

  private revoke(accountId: string): void {
    const token = this.tokens$.value.get(accountId);
    if (token) this.revokedTokens.add(token.accessToken);
  }

  /** A request with the live client, which meets a revoked token as the SDK would. */
  private request(
    accountId: string,
    send: () => EngineResult<null>,
  ): EngineResult<null> {
    const token = this.tokens$.value.get(accountId);
    if (!this.isLive(accountId) || !token) return engineFail(NOT_LIVE);
    if (!this.revokedTokens.has(token.accessToken)) return send();
    this.tokenDied(accountId);
    return engineFail(UNKNOWN_TOKEN);
  }

  /** A hard logout: held, it is only recorded and reported; otherwise the account is wiped. */
  private tokenDied(accountId: string): void {
    const held = [...this.holds.values()].filter(
      (hold) => hold.accountId === accountId,
    );
    if (held.length === 0) {
      this.drop(accountId);
      return;
    }
    this.diedWhileHeld.add(accountId);
    this.tell(accountId, { kind: 'token-died' });
  }

  private tell(accountId: string, update: ServerLogoutHoldUpdate): void {
    for (const hold of [...this.holds.values()]) {
      if (hold.accountId === accountId) hold.subscriber.next(update);
    }
  }

  private release(holdId: string, deleted: boolean): void {
    const hold = this.holds.get(holdId);
    if (!hold) return;
    this.holds.delete(holdId);
    hold.subscriber.complete();
    const { accountId } = hold;
    if (deleted) this.releasedAsDeleted.add(accountId);
    if ([...this.holds.values()].some((h) => h.accountId === accountId)) {
      return;
    }
    const keep = this.releasedAsDeleted.delete(accountId);
    if (this.diedWhileHeld.delete(accountId) && !keep) {
      this.drop(accountId);
    }
  }

  /** The account leaves the device and takes its holds with it. */
  private leave(accountId: string): void {
    this.diedWhileHeld.delete(accountId);
    this.releasedAsDeleted.delete(accountId);
    for (const [holdId, hold] of [...this.holds]) {
      if (hold.accountId !== accountId) continue;
      this.holds.delete(holdId);
      hold.subscriber.next({ kind: 'released' });
      hold.subscriber.complete();
    }
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
    this.refreshTokens.delete(accountId);
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
