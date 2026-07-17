import {
  Injectable,
  NgZone,
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
  from,
  map,
  of,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import {
  SessionStorageService,
  getTrinityDesktopBridge,
} from '@trinity/platform-native';
import { MatrixSession } from '@trinity/util-matrix';
import { preloadCryptoWasm } from '@trinity/util-matrix';
import { SecretStorageKeyHolder } from './secret-storage-key-holder';
import { TrinityOidcTokenRefresher } from './oidc-token-refresher';

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
  /** Its `ClientEvent.Sync` listener, kept so it can be detached on teardown. */
  readonly onSync: (state: SyncState) => void;
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
 * Lifecycle per account (see docs/PLAN.md / docs/STACK.md):
 *   createClient -> initRustCrypto({ cryptoDatabasePrefix }) -> startClient()
 *
 * Components must NOT import matrix-js-sdk directly — go through this service and
 * the feature services (auth, sync, timeline) layered on top.
 */
@Injectable({ providedIn: 'root' })
export class MatrixClientService {
  private readonly storage = inject(SessionStorageService);
  private readonly zone = inject(NgZone);

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
      return this.start(session).pipe(
        tap((account) => this._activeUserId.set(account.userId)),
        map(() => void 0),
      );
    });
  }

  /** Add another account (keeping the others syncing) and make it active. */
  add(session: MatrixSession): Observable<void> {
    return this.start(session).pipe(
      tap((account) => this._activeUserId.set(account.userId)),
      map(() => void 0),
    );
  }

  /** Start an account in the background WITHOUT making it active (see {@link restoreAll}). */
  warm(session: MatrixSession): Observable<void> {
    return this.start(session).pipe(map(() => void 0));
  }

  /** Switch the active account (no-op if it isn't signed in). Cheap — it's already live. */
  setActive(userId: string): void {
    if (this.clients.has(userId)) {
      this._activeUserId.set(userId);
    }
  }

  /** Restore the active persisted session on app start, if one exists. */
  restore(): Observable<boolean> {
    return this.storage
      .load()
      .pipe(
        switchMap((session) =>
          session ? this.init(session).pipe(map(() => true)) : of(false),
        ),
      );
  }

  /**
   * Restore every persisted account on app start: the active one first (awaited, for
   * a fast first paint), the rest warmed in the background so they sync too. Resolves
   * true once the active account is up, false when nothing is stored.
   */
  restoreAll(): Observable<boolean> {
    return defer(() => {
      // Cold-start disk hygiene: reclaim crypto stores orphaned by earlier versions (a
      // pre-fix sign-out deleted the wrong store) now, while no client holds them open.
      // Fire-and-forget — it must never delay or fail account restore.
      this.storage
        .sweepOrphanedCryptoStores()
        .subscribe({ error: () => undefined });
      return this.storage.list();
    }).pipe(
      switchMap((records) => {
        if (records.length === 0) {
          return of(false);
        }
        return this.storage.load().pipe(
          switchMap((active) => {
            if (!active) {
              return of(false);
            }
            return this.add(active).pipe(
              tap(() => this.warmOthers(records, active.userId)),
              map(() => true),
            );
          }),
        );
      }),
    );
  }

  /** Start every stored account except the active one, in the background (best-effort). */
  private warmOthers(
    records: readonly { userId: string }[],
    activeUserId: string,
  ): void {
    for (const record of records) {
      if (record.userId === activeUserId) {
        continue;
      }
      this.storage
        .load(record.userId)
        .pipe(
          switchMap((session) => {
            if (session) {
              return this.warm(session);
            }
            // No token → soft-logged-out in a prior session; surface it as a re-auth
            // candidate (its record + stores survive) so the switcher can offer sign-in.
            this.markSoftLoggedOut(record.userId);
            return of(void 0);
          }),
          catchError(() => of(void 0)),
        )
        .subscribe();
    }
  }

  /** Flag a user id as soft-logged-out (needs re-auth), re-entering the zone since
   * callers can fire from outside it. Deduped; cleared by a successful (re-)start. */
  private markSoftLoggedOut(userId: string): void {
    this.zone.run(() => {
      if (!this._softLoggedOut().includes(userId)) {
        this._softLoggedOut.set([...this._softLoggedOut(), userId]);
      }
    });
  }

  /** Stop syncing and tear down every client (without clearing any stores). */
  stop(): Observable<void> {
    return defer(() => {
      this.teardownAll();
      return of(void 0);
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
   * the map (not activated — the caller decides). Awaits a pending wipe for the same
   * account first. On failure it tears the half-started client down and rethrows.
   */
  private start(session: MatrixSession): Observable<AccountClient> {
    return defer(() => {
      // Replace any existing client for this account (a re-add / re-auth) so we
      // never orphan a running client — its Sync listener, and its sync store —
      // or open a second connection to its per-account IndexedDB.
      if (this.clients.has(session.userId)) {
        this.removeInternal(session.userId, false);
      }
      let created: MatrixClient | null = null;
      let store: IndexedDBStore | null = null;
      const syncState = signal<SyncState | null>(null);
      const onSync = (state: SyncState): void => syncState.set(state);
      const onLoggedOut = (err: MatrixError): void =>
        this.handleServerLogout(session.userId, err);
      // Per-account 4S key holder, wired only into THIS client's callbacks so a
      // background account's key op can't read/overwrite another account's key.
      const holder = new SecretStorageKeyHolder();
      return from(this.wipes.get(session.userId) ?? Promise.resolve()).pipe(
        switchMap(() => {
          store = this.createSyncStore(session.userId);
          // OIDC ("next-gen auth") sessions carry a refresh token: give the SDK the
          // token plus a per-account refresher so it silently rotates the short-lived
          // access token and persists the result (see TrinityOidcTokenRefresher).
          const refresher =
            session.refreshToken && session.oidc
              ? new TrinityOidcTokenRefresher(
                  this.storage,
                  session.userId,
                  session.oidc,
                  session.deviceId,
                )
              : null;
          created = createClient({
            baseUrl: session.baseUrl,
            accessToken: session.accessToken,
            userId: session.userId,
            deviceId: session.deviceId,
            ...(session.refreshToken
              ? { refreshToken: session.refreshToken }
              : {}),
            ...(refresher
              ? {
                  tokenRefreshFunction: (token: string) =>
                    refresher.doRefreshAccessToken(token),
                }
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
        switchMap(() => preloadCryptoWasm()),
        switchMap(() =>
          // Per-account crypto store; unset prefix (migrated legacy account) → the
          // SDK default store, preserving its existing keys.
          from(
            created!.initRustCrypto({
              cryptoDatabasePrefix: session.cryptoPrefix,
            }),
          ),
        ),
        tap(() => {
          created!.on(ClientEvent.Sync, onSync);
          created!.on(HttpApiEvent.SessionLoggedOut, onLoggedOut);
        }),
        switchMap(() =>
          from(
            created!.startClient({ initialSyncLimit: 20, threadSupport: true }),
          ),
        ),
        map(() => {
          const account: AccountClient = {
            userId: session.userId,
            client: created!,
            cryptoPrefix: session.cryptoPrefix,
            syncStore: store,
            syncState,
            onSync,
            onLoggedOut,
            holder,
          };
          this.clients.set(session.userId, account);
          this._accountIds.set([...this.clients.keys()]);
          this.publishCorsOrigins();
          // A successful (re-)start clears any prior soft-logout — re-auth restored it.
          this.clearSoftLoggedOut(session.userId);
          return account;
        }),
        catchError((err) => {
          created?.off(ClientEvent.Sync, onSync);
          created?.off(HttpApiEvent.SessionLoggedOut, onLoggedOut);
          created?.stopClient();
          holder.clear();
          this.closeStore(store);
          return throwError(() => err);
        }),
      );
    });
  }

  /** Stop + drop every client (no store deletion), and forget the 4S key. */
  private teardownAll(): void {
    for (const account of this.clients.values()) {
      account.client.off(ClientEvent.Sync, account.onSync);
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
      return;
    }
    account.client.off(ClientEvent.Sync, account.onSync);
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
      const wipeDone = account.client
        .clearStores({ cryptoDatabasePrefix: account.cryptoPrefix })
        .catch(() => undefined)
        .finally(() => this.closeStore(store));
      this.wipes.set(userId, wipeDone);
      // Prune the entry once it settles (unless a newer wipe replaced it), so the
      // map doesn't grow across logout/login cycles or leave a stale promise behind.
      void wipeDone.finally(() => {
        if (this.wipes.get(userId) === wipeDone) {
          this.wipes.delete(userId);
        }
      });
    } else {
      this.closeStore(account.syncStore);
    }
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
    // The SDK emits this from a network callback OUTSIDE Angular's zone; re-enter so
    // the signal writes below flush the reproject + redirect effects promptly rather
    // than on the next incidental change detection.
    this.zone.run(() => {
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
    });
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
      dbName: `trinity-sync:${userId}`,
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
