import {
  Injectable,
  Signal,
  WritableSignal,
  computed,
  signal,
  inject,
} from '@angular/core';
import {
  createClient,
  IndexedDBStore,
  MatrixClient,
  ClientEvent,
  HttpApiEvent,
  SyncState,
  type MatrixError,
} from 'matrix-js-sdk';
import {
  Observable,
  catchError,
  defer,
  finalize,
  firstValueFrom,
  from,
  map,
  of,
  shareReplay,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import {
  SessionStorageService,
  deleteDatabase,
  getTrinityDesktopBridge,
} from '@trinity/platform-native';
import {
  ProjectionRuntime,
  type ProjectionLease,
} from '@trinity/runtime/projection';
import {
  describeMatrixRequestFailure,
  MatrixSession,
  preloadCryptoWasm,
  rustCryptoStoreDbNames,
  syncStoreDbName,
  syncStoreIndexedDbName,
} from '@trinity/util/matrix';
import { SecretStorageKeyHolder } from './secret-storage-key-holder';
import { TrinityOidcTokenRefresher } from './oidc-token-refresher';

/** Default deadline for ordinary Matrix HTTP requests made by an account client. */
const MATRIX_REQUEST_TIMEOUT_MS = 30_000;

/** Resource ceiling for the first production Projection Runtime adapter. */
export const MATRIX_SYNC_PROJECTION_BASELINE = {
  listenerCountPerLiveAccount: 1,
  maxRetainedBytesPerLiveAccount:
    (SyncState.Reconnecting.length + SyncState.Prepared.length) * 2,
} as const;

export type PersistedAccountStartOutcome =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'failed';
      readonly failure:
        'reauthentication-required' | 'transient-network' | 'crypto-failure';
    };

export type PersistedAccountActivation = 'activate' | 'background';

type PersistedAccountStartFailure = Extract<
  PersistedAccountStartOutcome,
  { kind: 'failed' }
>['failure'];

class MatrixClientStartupError extends Error {
  constructor(
    readonly failure: PersistedAccountStartFailure,
    readonly original: unknown,
  ) {
    super(`Matrix Account startup failed: ${failure}`);
  }
}

function expectedClientStartFailure(
  error: unknown,
): PersistedAccountStartFailure | null {
  const candidate = isRecord(error) ? error : {};
  const data = isRecord(candidate['data']) ? candidate['data'] : {};
  const errcode =
    typeof candidate['errcode'] === 'string'
      ? candidate['errcode']
      : typeof data['errcode'] === 'string'
        ? data['errcode']
        : null;
  if (errcode === 'M_UNKNOWN_TOKEN' || errcode === 'M_MISSING_TOKEN') {
    return 'reauthentication-required';
  }
  const described = describeMatrixRequestFailure(error).kind;
  if (described === 'authentication') {
    return 'reauthentication-required';
  }
  if (
    described === 'network' ||
    described === 'timeout' ||
    described === 'rate-limit' ||
    described === 'server'
  ) {
    return 'transient-network';
  }
  const status =
    typeof candidate['httpStatus'] === 'number'
      ? candidate['httpStatus']
      : null;
  const transientStatus =
    status === 0 ||
    status === 408 ||
    status === 429 ||
    (status !== null && status >= 500);
  const transientName =
    candidate['name'] === 'AbortError' || candidate['name'] === 'TimeoutError';
  return transientStatus || transientName ? 'transient-network' : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function classifyCryptoStartupFailure(error: unknown): Observable<never> {
  return throwError(
    () => new MatrixClientStartupError('crypto-failure', error),
  );
}

/** One signed-in account's live client + the per-account state bound to it. */
interface AccountClient {
  readonly userId: string;
  readonly client: MatrixClient;
  /**
   * This account's Rust crypto-store `cryptoDatabasePrefix` (undefined for a migrated
   * legacy account on the SDK default). Retained so a logout wipe can delete THIS
   * account's crypto IndexedDB rather than the default-prefix one — otherwise the
   * account's real store is orphaned and a later fresh login (new device id, same
   * userId-derived prefix) reopens a store whose device id mismatches the new one.
   */
  readonly cryptoPrefix: string | undefined;
  /** The account's persistent sync store, retained so its IndexedDB can be closed. */
  readonly syncStore: IndexedDBStore | null;
  /** This account's coarse sync state (null until its first sync transition). */
  readonly syncState: WritableSignal<SyncState | null>;
  /** Projection Runtime lease owning sync-state attachment and reset. */
  readonly syncProjection: ProjectionLease;
  /** Its `HttpApiEvent.SessionLoggedOut` listener (server-side token revocation). */
  readonly onLoggedOut: (err: MatrixError) => void;
  /** Its own 4S key holder, wired into this client's crypto callbacks. */
  readonly holder: SecretStorageKeyHolder;
}

/**
 * Owns the live matrix-js-sdk clients and their lifecycle. Holds a registry of
 * accounts (`Map<userId, AccountClient>`), all of which sync, with one marked
 * **active**. {@link instance} returns the active account's client, so the ~78
 * `this.matrix.instance` readers stay scoped to whichever account is in view.
 *
 * Lifecycle per account (see docs/architecture/matrix-and-encryption.md):
 *   createClient -> initRustCrypto({ cryptoDatabasePrefix }) -> startClient()
 *
 * Components must NOT import matrix-js-sdk directly — go through this service and
 * the feature services (auth, sync, timeline) layered on top.
 */
@Injectable({ providedIn: 'root' })
export class MatrixClientService {
  private readonly storage = inject(SessionStorageService);
  private readonly projections = inject(ProjectionRuntime);

  private readonly clients = new Map<string, AccountClient>();

  /**
   * Tell the Electron main process which origins we legitimately talk to, so its CORS
   * shim can be scoped to them instead of rewriting every remote https response (see
   * electron/src/cors.ts). Main cannot know this: the user picks homeservers at login,
   * and there may be several. Called wherever the live account set changes; a no-op off
   * desktop, where the bridge is absent.
   */
  private publishCorsOrigins(): void {
    const bridge = getTrinityDesktopBridge();
    if (!bridge?.cors) {
      return;
    }
    const origins = [...this.clients.values()].map((a) => a.client.baseUrl);
    bridge.cors.setAllowedOrigins(origins);
  }

  /**
   * Declare ONE origin to the same shim, additively. Needed before an account's client
   * exists, where {@link publishCorsOrigins} — which reads the live client set — cannot
   * name it yet: `startClient()` issues `/_matrix/client/versions`, the thread-support
   * probe and the first `/sync` before it resolves, so publishing only afterwards leaves
   * all three to be blocked against a homeserver whose proxy strips CORS headers (a failed
   * `getVersions()` disables server-side threads for the whole session). The post-start
   * {@link publishCorsOrigins} still replaces the set, so removals keep applying.
   */
  private allowCorsOrigin(origin: string): void {
    getTrinityDesktopBridge()?.cors?.allowOrigin(origin);
  }
  private readonly _activeUserId = signal<string | null>(null);
  /** The account currently in view (whose client {@link instance} returns). */
  readonly activeUserId = this._activeUserId.asReadonly();

  private readonly _accountIds = signal<readonly string[]>([]);
  /** Every signed-in account's user id (for the account switcher). */
  readonly accountIds = this._accountIds.asReadonly();

  private readonly _softLoggedOut = signal<readonly string[]>([]);
  /**
   * Accounts the server soft-logged-out (token revoked, device kept): stopped but
   * their stores are preserved, and their registry entry stays, so re-authenticating
   * restores them. Distinct from a full sign-out, which wipes and forgets the account.
   */
  readonly softLoggedOut = this._softLoggedOut.asReadonly();

  /**
   * In-flight background store wipes started by {@link reset}/{@link remove},
   * keyed by user id. Re-adding that account awaits its wipe first: the sync +
   * Rust-crypto IndexedDB names repeat across a same-account re-login, so opening
   * either before the pending delete finishes would block (or race) it.
   */
  private readonly wipes = new Map<string, Promise<void>>();

  /**
   * Starts that have not finished yet, keyed by user id — see {@link start} for why a
   * second start must join the first rather than build a second client.
   */
  private readonly starting = new Map<string, Observable<AccountClient>>();

  /** Coarse sync state of the ACTIVE account (null until its first transition). */
  readonly syncState: Signal<SyncState | null> = computed(() => {
    // Depend on the account set too, so re-adding the active user re-binds to its
    // fresh per-account signal even when the active id is unchanged.
    this._accountIds();
    return this.active()?.syncState() ?? null;
  });

  /**
   * Connectivity for the UI: `offline` once the active account's sync is erroring
   * or reconnecting, else `online` (including the pre-first-sync window, so a fresh
   * start doesn't flash offline). Cached data still renders while offline thanks to
   * the persistent IndexedDB sync store.
   */
  readonly connectivity = computed<'online' | 'offline'>(() => {
    const state = this.syncState();
    return state === SyncState.Error || state === SyncState.Reconnecting
      ? 'offline'
      : 'online';
  });

  get instance(): MatrixClient {
    const account = this.active();
    if (!account) {
      throw new Error(
        'MatrixClient not initialized — call init()/add() first.',
      );
    }
    return account.client;
  }

  get isInitialized(): boolean {
    return this.active() !== null;
  }

  /** Every live account client, for cross-account aggregation (badge, notifications). */
  all(): readonly AccountClient[] {
    return [...this.clients.values()];
  }

  /** The active account's 4S key holder (populated by the crypto-setup UI), or null. */
  activeHolder(): SecretStorageKeyHolder | null {
    return this.active()?.holder ?? null;
  }

  /** The live client for a specific account, or null (e.g. per-account server logout). */
  clientFor(userId: string): MatrixClient | null {
    return this.clients.get(userId)?.client ?? null;
  }

  /**
   * Replace any signed-in accounts with this one and make it active. Cold: runs on
   * subscribe. The login-replaces-current path; use {@link add} to keep the others.
   * The new client is only published once it has fully started — a failed bootstrap
   * cleans up and rethrows rather than leaving a half-initialized client behind.
   */
  init(session: MatrixSession): Observable<void> {
    return defer(() => {
      this.teardownAll();
      return this.startForExistingCaller(session).pipe(
        tap((account) => this._activeUserId.set(account.userId)),
        map(() => void 0),
      );
    });
  }

  /** Add another account (keeping the others syncing) and make it active. */
  add(session: MatrixSession): Observable<void> {
    return this.startForExistingCaller(session).pipe(
      tap((account) => this._activeUserId.set(account.userId)),
      map(() => void 0),
    );
  }

  /** Start one persisted Account without leaking adapter errors into Account Runtime. */
  restorePersisted(
    session: MatrixSession,
    activation: PersistedAccountActivation,
  ): Observable<PersistedAccountStartOutcome> {
    return this.start(session).pipe(
      tap((account) => {
        if (activation === 'activate') {
          this._activeUserId.set(account.userId);
        }
      }),
      map(() => ({ kind: 'ready' as const })),
      catchError((error: unknown) =>
        error instanceof MatrixClientStartupError
          ? defer(() => {
              if (error.failure === 'reauthentication-required') {
                this.requireReauthentication(session.userId);
              }
              return of({ kind: 'failed' as const, failure: error.failure });
            })
          : throwError(() => error),
      ),
    );
  }

  /** Keep legacy reauthentication surfaces coherent during the Account Runtime migration. */
  requireReauthentication(userId: string): void {
    this.markSoftLoggedOut(userId);
  }

  /** Switch the active account (no-op if it isn't signed in). Cheap — it's already live. */
  setActive(userId: string): void {
    if (this.clients.has(userId)) {
      this._activeUserId.set(userId);
    }
  }

  /**
   * Commit placement of an Account that Account Runtime already started in the background.
   * `replace` retires other live clients only after the replacement is known-good.
   */
  activateAccount(userId: string, liveAccounts: 'keep' | 'replace'): void {
    if (!this.clients.has(userId)) {
      throw new Error(
        `Matrix Runtime cannot activate an Account that is not live: ${userId}`,
      );
    }
    if (liveAccounts === 'replace') {
      for (const existingId of [...this.clients.keys()]) {
        if (existingId !== userId) {
          this.removeInternal(existingId, false);
        }
      }
    }
    this._activeUserId.set(userId);
  }

  /** Roll back a background Account start without deleting its persisted stores. */
  rollbackAccountStart(userId: string): Observable<void> {
    return defer(() => {
      this.removeInternal(userId, false);
      return of(void 0);
    });
  }

  /** Flag a user id as soft-logged-out (needs re-auth). The signal write schedules
   * change detection on its own. Deduped; cleared by a successful (re-)start. */
  private markSoftLoggedOut(userId: string): void {
    if (!this._softLoggedOut().includes(userId)) {
      this._softLoggedOut.set([...this._softLoggedOut(), userId]);
    }
  }

  /** Stop syncing and tear down every client (without clearing any stores). */
  stop(): Observable<void> {
    return defer(() => {
      this.teardownAll();
      return of(void 0);
    });
  }

  /**
   * Ask the homeserver to invalidate every live account's device, best-effort.
   *
   * For the factory reset, which must work when the homeserver is unreachable — so each
   * logout is caught on the RAW promise rather than through `catchError`. The caller races
   * this against a timeout, and `race` unsubscribes the loser: a promise that rejects after
   * its subscriber has closed reaches RxJS's unhandled-error reporter, and from there the
   * global error handler, which would surface a toast in the middle of a deliberate wipe.
   *
   * Resolves once every attempt has settled; never errors. Does NOT tear the clients down,
   * so it must be called while they are still LIVE — `stop()` empties the registry this
   * reads, and calling it afterwards signs nothing out at all while looking identical from
   * the outside. Sequence it before the teardown, not after.
   */
  signOutAll(): Observable<void> {
    return defer(() => {
      const logouts = [...this.clients.values()].map((account) =>
        account.client.logout(true).catch(() => undefined),
      );
      return from(Promise.all(logouts).then(() => undefined));
    });
  }

  /**
   * Log the ACTIVE account out: stop it, DELETE its persistent stores (sync +
   * crypto IndexedDB), and repoint the active account to another if any remain.
   * Best-effort: a store-clear failure still tears the client down.
   */
  reset(): Observable<void> {
    return defer(() => {
      const account = this.active();
      if (!account) {
        return of(void 0);
      }
      this.removeInternal(account.userId, true);
      return of(void 0);
    });
  }

  /** Sign one account out: stop it + wipe its stores; repoint active if needed. */
  remove(userId: string): Observable<void> {
    return defer(() => {
      this.removeInternal(userId, true);
      return of(void 0);
    });
  }

  /** The active account client, or null when none is signed in / active. */
  private active(): AccountClient | null {
    const id = this._activeUserId();
    return id ? (this.clients.get(id) ?? null) : null;
  }

  /**
   * Build a client from a session, bootstrap E2EE, start syncing, and register it in
   * the map (not activated — the caller decides). On failure it tears the half-started
   * client down and rethrows.
   *
   * **Idempotent per account while in flight**, and independent of the caller's
   * subscription surviving. Both matter because the callers are guards: the Router
   * unsubscribes a guard whose navigation is superseded, and the start chain (open
   * IndexedDB → WASM → `initRustCrypto` → `startClient`) is long enough that a deep link
   * arriving mid-flight begins a second one for the same account. Two `initRustCrypto`
   * calls on one device open the same crypto store twice, which is the shape that produces
   * device-key divergence.
   *
   * So a second `start()` for the same user id JOINS the first, and the shared chain is
   * `refCount: false` deliberately — losing the last subscriber must not cancel it, or a
   * cancelled navigation would leave a half-open store behind for the next login to collide
   * with. It always runs to the end and then, if nothing consumed its result, rolls itself
   * back (see `rollback` in {@link startNew}).
   */
  private start(session: MatrixSession): Observable<AccountClient> {
    return defer(() => {
      const inFlight = this.starting.get(session.userId);
      if (inFlight) {
        return inFlight;
      }
      // Set by the tap BELOW the share, so it is true exactly when some subscriber
      // received the started account — the signal `startNew` uses to decide whether this
      // start was wanted. A subscriber count would not do: `firstValueFrom` unsubscribes
      // on the value, so a perfectly consumed start also ends with zero subscribers.
      let delivered = false;
      const started: Observable<AccountClient> = this.startNew(
        session,
        () => delivered,
      ).pipe(
        finalize(() => {
          if (this.starting.get(session.userId) === started) {
            this.starting.delete(session.userId);
          }
        }),
        // Not cached across calls: the entry is dropped above the moment the chain
        // settles, so a FAILED start is never replayed to a later caller.
        shareReplay({ bufferSize: 1, refCount: false }),
        tap(() => {
          delivered = true;
        }),
      );
      this.starting.set(session.userId, started);
      return started;
    });
  }

  /** Preserve the existing login/auth interface while Account Runtime consumes typed failures. */
  private startForExistingCaller(
    session: MatrixSession,
  ): Observable<AccountClient> {
    return this.start(session).pipe(
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof MatrixClientStartupError ? error.original : error,
        ),
      ),
    );
  }

  /**
   * One actual start attempt: awaits a pending wipe for the same account, then builds,
   * bootstraps and registers the client. See {@link start}, which owns the joining and
   * the cancellation semantics.
   */
  private startNew(
    session: MatrixSession,
    consumed: () => boolean,
  ): Observable<AccountClient> {
    return defer(() => {
      // Replace any existing client for this account (a re-add / re-auth) so we
      // never orphan a running client — its Sync listener, and its sync store —
      // or open a second connection to its per-account IndexedDB.
      if (this.clients.has(session.userId)) {
        this.removeInternal(session.userId, false);
      }
      let created: MatrixClient | null = null;
      let store: IndexedDBStore | null = null;
      let account: AccountClient | null = null;
      let syncProjection: ProjectionLease | null = null;
      const syncState = signal<SyncState | null>(null);
      let latestSyncState: SyncState | null = null;
      const onLoggedOut = (err: MatrixError): void =>
        this.handleServerLogout(session.userId, err);
      // Per-account 4S key holder, wired only into THIS client's callbacks so a
      // background account's key op can't read/overwrite another account's key.
      const holder = new SecretStorageKeyHolder();
      /**
       * Undo whatever this attempt managed to do. Driven from `finalize`, so it covers the
       * error path AND the cancelled one — an unsubscribed start still reaches the end,
       * and without this its client would sync on, unreachable, with its crypto store open.
       */
      const rollback = (): void => {
        if (account) {
          // It finished after its caller had gone: hand it to the normal removal path,
          // which detaches, stops, closes the store and repoints the active account.
          if (this.clients.get(session.userId) === account) {
            this.removeInternal(session.userId, false);
          }
          return;
        }
        syncProjection?.release();
        created?.off(HttpApiEvent.SessionLoggedOut, onLoggedOut);
        created?.stopClient();
        holder.clear();
        this.closeStore(store);
      };
      return from(this.wipes.get(session.userId) ?? Promise.resolve()).pipe(
        switchMap(() => {
          store = this.createSyncStore(session.userId);
          // Declared before the client is built, so the first requests it makes — inside
          // startClient(), which resolves only after them — are already served.
          this.allowCorsOrigin(session.baseUrl);
          // OIDC ("next-gen auth") sessions carry a refresh token: give the SDK the
          // token plus a per-account refresher so it silently rotates the short-lived
          // access token and persists the result (see TrinityOidcTokenRefresher).
          const refresher =
            session.refreshToken && session.oidc
              ? new TrinityOidcTokenRefresher({
                  storage: this.storage,
                  userId: session.userId,
                  baseUrl: session.baseUrl,
                  binding: session.oidc,
                  deviceId: session.deviceId,
                })
              : null;
          created = createClient({
            baseUrl: session.baseUrl,
            // Without a client-level deadline, a socket that accepts a request and never
            // answers leaves every downstream busy/finalize path pending indefinitely.
            // Long-poll sync calls pass their own larger local timeout to the SDK.
            localTimeoutMs: MATRIX_REQUEST_TIMEOUT_MS,
            accessToken: session.accessToken,
            userId: session.userId,
            deviceId: session.deviceId,
            ...(session.refreshToken
              ? { refreshToken: session.refreshToken }
              : {}),
            ...(refresher
              ? { tokenRefreshFunction: refresher.tokenRefreshFunction }
              : {}),
            ...(store ? { store } : {}),
            // Lets the crypto stack read/write 4S using the recovery key the user
            // unlocks during the setup/recovery flows (held only in memory).
            cryptoCallbacks: {
              getSecretStorageKey: holder.getSecretStorageKey,
              cacheSecretStorageKey: holder.cacheSecretStorageKey,
            },
          });
          // Best-effort cache load; a corrupt/blocked IndexedDB must NOT block login.
          return from(
            store ? store.startup().catch(() => undefined) : Promise.resolve(),
          );
        }),
        switchMap(() =>
          preloadCryptoWasm().pipe(catchError(classifyCryptoStartupFailure)),
        ),
        switchMap(() =>
          // Per-account crypto store; unset prefix (migrated legacy account) → the
          // SDK default store, preserving its existing keys.
          from(
            created!.initRustCrypto({
              cryptoDatabasePrefix: session.cryptoPrefix,
            }),
          ).pipe(catchError(classifyCryptoStartupFailure)),
        ),
        tap(() => {
          const client = created!;
          syncProjection = this.projections.activate({
            id: 'matrix.sync-state',
            scope: { kind: 'exact-account', accountId: session.userId },
            attach: (invalidate) => {
              const onSync = (state: SyncState): void => {
                latestSyncState = state;
                invalidate();
              };
              client.on(ClientEvent.Sync, onSync);
              return () => client.off(ClientEvent.Sync, onSync);
            },
            reconcile: ({ publish }) =>
              defer(() => {
                publish(() => syncState.set(latestSyncState));
                return of(void 0);
              }),
            reset: () => syncState.set(null),
            resources: () => ({
              listenerCount:
                MATRIX_SYNC_PROJECTION_BASELINE.listenerCountPerLiveAccount,
              retainedBytes: retainedSyncProjectionBytes(
                syncState(),
                latestSyncState,
              ),
            }),
          });
          created!.on(HttpApiEvent.SessionLoggedOut, onLoggedOut);
        }),
        switchMap(() =>
          from(
            created!.startClient({ initialSyncLimit: 20, threadSupport: true }),
          ).pipe(
            catchError((error: unknown) => {
              const failure = expectedClientStartFailure(error);
              return failure
                ? throwError(() => new MatrixClientStartupError(failure, error))
                : throwError(() => error);
            }),
          ),
        ),
        map(() => {
          if (!syncProjection) {
            throw new Error(
              `Matrix Runtime started without a sync projection: ${session.userId}`,
            );
          }
          const started: AccountClient = {
            userId: session.userId,
            client: created!,
            cryptoPrefix: session.cryptoPrefix,
            syncStore: store,
            syncState,
            syncProjection,
            onLoggedOut,
            holder,
          };
          account = started;
          this.clients.set(session.userId, started);
          this._accountIds.set([...this.clients.keys()]);
          this.publishCorsOrigins();
          // A successful (re-)start clears any prior soft-logout — re-auth restored it.
          this.clearSoftLoggedOut(session.userId);
          return started;
        }),
        switchMap((started) =>
          this.projections
            .waitFor({
              kind: 'exact-account',
              accountId: started.userId,
            })
            .pipe(map(() => started)),
        ),
        // Covers error, completion and unsubscription in one place; the error still
        // propagates untouched to the caller.
        finalize(() => {
          if (!consumed()) {
            rollback();
          }
        }),
      );
    });
  }

  /** Stop + drop every client (no store deletion), and forget the 4S key. */
  private teardownAll(): void {
    for (const account of this.clients.values()) {
      account.syncProjection.release();
      account.client.off(HttpApiEvent.SessionLoggedOut, account.onLoggedOut);
      account.client.stopClient();
      account.holder.clear();
      this.closeStore(account.syncStore);
    }
    this.clients.clear();
    this._accountIds.set([]);
    this.publishCorsOrigins();
    this._activeUserId.set(null);
    this._softLoggedOut.set([]);
  }

  /**
   * Remove one account: stop it, drop it from the map, repoint active if it was
   * active, and either wipe (logout) or just close (switch-away) its stores.
   */
  private removeInternal(userId: string, wipe: boolean): void {
    this.clearSoftLoggedOut(userId); // any removal clears a stale re-auth flag
    const account = this.clients.get(userId);
    if (!account) {
      if (wipe) {
        // "Stop it + wipe its stores" must still wipe when there is nothing to stop —
        // the normal state for a soft-logged-out account, or one whose background
        // warm-up failed. The caller deletes the registry record moments later, and
        // that record is the only thing naming this account's crypto store.
        this.wipeStoresByName(userId);
      }
      return;
    }
    account.syncProjection.release();
    account.client.off(HttpApiEvent.SessionLoggedOut, account.onLoggedOut);
    account.client.stopClient(); // clearStores must run with the client stopped
    account.holder.clear(); // forget this account's 4S key
    this.clients.delete(userId);
    this._accountIds.set([...this.clients.keys()]);
    this.publishCorsOrigins();
    if (this._activeUserId() === userId) {
      this._activeUserId.set(this.clients.keys().next().value ?? null);
    }
    if (wipe) {
      // clearStores() deletes this account's sync + Rust-crypto IndexedDB. Pass the
      // account's OWN cryptoDatabasePrefix so the Rust store deleted is this account's
      // (`${prefix}::matrix-sdk-crypto`), not the SDK default — omitting it orphans the
      // real store and breaks a later fresh login with an account/device-id mismatch.
      // The crypto delete can block ~25s (the WASM store connection releases only on
      // GC), so run it as a tracked BACKGROUND wipe keyed by user id; a re-add of the
      // same account awaits it. Best-effort — a failure still leaves the client removed.
      const store = account.syncStore;
      this.trackWipe(
        userId,
        account.client
          .clearStores({ cryptoDatabasePrefix: account.cryptoPrefix })
          .catch(() => undefined)
          .finally(() => this.closeStore(store)),
      );
    } else {
      this.closeStore(account.syncStore);
    }
  }

  /**
   * Delete a NON-live account's IndexedDB by name: its sync store, plus the Rust crypto
   * pair derived from the registry record's `cryptoPrefix` (the same prefix the live path
   * hands `clearStores`). Without a record we only know the sync-store name — the
   * SDK-default crypto pair may belong to a migrated legacy account, so it is left for the
   * cold-start orphan sweep rather than guessed at.
   *
   * Best-effort and bounded (`deleteDatabase` settles even when a connection blocks it),
   * and tracked like the live wipe so a re-add of this account awaits it.
   */
  private wipeStoresByName(userId: string): void {
    const idb = globalThis.indexedDB;
    if (typeof idb === 'undefined') {
      return;
    }
    const wipeDone = firstValueFrom(this.storage.record(userId))
      .then(async (record) => {
        const names = [syncStoreIndexedDbName(userId)];
        if (record) {
          names.push(...rustCryptoStoreDbNames(record.cryptoPrefix));
        }
        await Promise.all(names.map((name) => deleteDatabase(idb, name)));
      })
      .catch(() => undefined);
    this.trackWipe(userId, wipeDone);
  }

  /**
   * Track an in-flight store wipe, and prune the entry once it settles (unless a newer
   * wipe replaced it) so the map doesn't grow across logout/login cycles.
   */
  private trackWipe(userId: string, wipeDone: Promise<void>): void {
    this.wipes.set(userId, wipeDone);
    void wipeDone.finally(() => {
      if (this.wipes.get(userId) === wipeDone) {
        this.wipes.delete(userId);
      }
    });
  }

  /**
   * Handle a server-side session logout for one account (`M_UNKNOWN_TOKEN`). A **soft**
   * logout (`soft_logout: true`) keeps the device + stores: stop the client without
   * wiping and mark it {@link softLoggedOut}, so re-authenticating (its registry entry
   * and crypto-store prefix are preserved) restores it. A **hard** logout (device
   * deleted server-side) wipes the account's stores and drops its registry entry. Either
   * way the other accounts keep running, and if this was the active one the active
   * pointer moves to a survivor (or null when it was the last).
   */
  private handleServerLogout(userId: string, err: MatrixError): void {
    if (!this.clients.has(userId)) {
      return; // already torn down
    }
    const soft =
      (err.data as { soft_logout?: boolean } | undefined)?.soft_logout === true;
    // This runs from an SDK network callback; the signal writes below schedule change
    // detection on their own, driving the reproject + redirect effects.
    if (soft) {
      // Keep the stores + registry entry for re-auth, but drop the now-dead token so
      // a restart's restore skips it instead of resurrecting a failing ghost account.
      this.removeInternal(userId, false);
      this.storage
        .invalidateToken(userId)
        .subscribe({ error: () => undefined });
      this.markSoftLoggedOut(userId);
    } else {
      // Hard logout: the device is gone server-side — wipe locally (which also clears
      // any soft-logout flag) and forget the account.
      this.removeInternal(userId, true);
      this.storage.remove(userId).subscribe({ error: () => undefined });
    }
    // Reconcile the persisted active pointer with the surviving in-memory active:
    // removeInternal repoints in memory by Map order, storage.remove by array order,
    // so without this a restart could restore a different account than the UI shows.
    const active = this._activeUserId();
    if (active) {
      this.storage.setActive(active).subscribe({ error: () => undefined });
    }
  }

  /** Drop a user id from the soft-logged-out set (on re-auth or full removal). */
  private clearSoftLoggedOut(userId: string): void {
    if (this._softLoggedOut().includes(userId)) {
      this._softLoggedOut.set(
        this._softLoggedOut().filter((id) => id !== userId),
      );
    }
  }

  /**
   * Build a persistent IndexedDB sync store scoped to the account, or null when
   * IndexedDB is unavailable (non-browser / unit tests) so the SDK falls back to
   * its in-memory store.
   */
  private createSyncStore(userId: string): IndexedDBStore | null {
    if (typeof globalThis.indexedDB === 'undefined') {
      return null;
    }
    return new IndexedDBStore({
      indexedDB: globalThis.indexedDB,
      // Per-account database so multiple accounts on one device don't share a cache.
      // Note the SDK prepends `matrix-js-sdk:` to this — see syncStoreIndexedDbName, which
      // is what anything deleting the database by name has to use.
      dbName: syncStoreDbName(userId),
    });
  }

  /**
   * Close (and release) a specific IndexedDB sync-store instance. Taken by value so a
   * long-running background wipe destroys the store it was started for — never a newer
   * store a re-login may open while the wipe is still pending.
   */
  private closeStore(store: IndexedDBStore | null): void {
    if (store) {
      void Promise.resolve()
        .then(() => store.destroy())
        .catch(() => undefined);
    }
  }
}

/** Counts both published and pending payloads without double-counting one shared value. */
function retainedSyncProjectionBytes(
  publishedState: SyncState | null,
  latestState: SyncState | null,
): number {
  const publishedBytes = retainedSyncStateBytes(publishedState);
  return latestState === publishedState
    ? publishedBytes
    : publishedBytes + retainedSyncStateBytes(latestState);
}

/** Deterministic payload bytes; runtime/engine object overhead remains profiler evidence. */
function retainedSyncStateBytes(state: SyncState | null): number {
  return state === null ? 0 : state.length * 2;
}
