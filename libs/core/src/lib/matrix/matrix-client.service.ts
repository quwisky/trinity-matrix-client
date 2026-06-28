import { Injectable, computed, signal, inject } from '@angular/core';
import {
  createClient,
  IndexedDBStore,
  MatrixClient,
  ClientEvent,
  SyncState,
} from 'matrix-js-sdk';
import {
  Observable,
  catchError,
  defer,
  finalize,
  from,
  map,
  of,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import { SessionStorageService } from '../storage/session-storage.service';
import { MatrixSession } from './session.model';
import { preloadCryptoWasm } from './crypto-wasm-loader';
import { SecretStorageKeyService } from './secret-storage-key.service';

/**
 * Owns the single matrix-js-sdk MatrixClient instance and its lifecycle.
 *
 * Lifecycle contract (see PLAN.md / STACK.md):
 *   createClient -> initRustCrypto() -> startClient()
 * The legacy `client.crypto` is gone; use `client.getCrypto()` for the CryptoApi.
 *
 * Components must NOT import matrix-js-sdk directly — go through this service and
 * the feature services (auth, sync, timeline) layered on top.
 */
@Injectable({ providedIn: 'root' })
export class MatrixClientService {
  private readonly storage = inject(SessionStorageService);
  private readonly secretStorageKeys = inject(SecretStorageKeyService);
  private client: MatrixClient | null = null;
  /** The persistent sync store, retained so its IndexedDB connection can be closed. */
  private syncStore: IndexedDBStore | null = null;

  /** Coarse sync state for the UI (null until the first sync transition). */
  private readonly _syncState = signal<SyncState | null>(null);
  readonly syncState = this._syncState.asReadonly();

  /**
   * Connectivity for the UI: `offline` once sync is erroring or reconnecting after
   * a connection loss, else `online` (including the pre-first-sync window, so a
   * fresh start doesn't flash an offline banner). Cached data still renders while
   * offline thanks to the persistent IndexedDB sync store. (`Stopped` maps to
   * `online` here but is unreachable — teardown detaches this listener first.)
   */
  readonly connectivity = computed<'online' | 'offline'>(() => {
    const state = this._syncState();
    return state === SyncState.Error || state === SyncState.Reconnecting
      ? 'offline'
      : 'online';
  });

  /** Stable reference so the listener can be removed in {@link teardown}. */
  private readonly onSync = (state: SyncState): void =>
    this._syncState.set(state);

  get instance(): MatrixClient {
    if (!this.client) {
      throw new Error('MatrixClient not initialized — call init() first.');
    }
    return this.client;
  }

  get isInitialized(): boolean {
    return this.client !== null;
  }

  /**
   * Build the client from a session, bootstrap E2EE, and start syncing.
   * E2EE is enabled in MVP, so initRustCrypto() runs before startClient().
   * Cold: the work runs when the returned Observable is subscribed.
   *
   * Idempotent: any live client is torn down first (clearing the previous
   * session's 4S key), so a re-login never leaks secrets across accounts. The
   * new client is only published once it has fully started — a failed bootstrap
   * cleans up and rethrows rather than leaving a half-initialized client behind.
   */
  init(session: MatrixSession): Observable<void> {
    return defer(() => {
      this.teardown();
      // Persist the sync store to IndexedDB (per-account) so rooms/timelines are
      // cached for fast startup and offline reads; falls back to the SDK's
      // in-memory store outside a browser (e.g. unit tests).
      const store = this.createSyncStore(session.userId);
      this.syncStore = store;
      const client = createClient({
        baseUrl: session.baseUrl,
        accessToken: session.accessToken,
        userId: session.userId,
        deviceId: session.deviceId,
        ...(store ? { store } : {}),
        // Lets the crypto stack read/write 4S using the recovery key the user
        // unlocks during the setup/recovery flows (held only in memory).
        cryptoCallbacks: {
          getSecretStorageKey: this.secretStorageKeys.getSecretStorageKey,
          cacheSecretStorageKey: this.secretStorageKeys.cacheSecretStorageKey,
        },
      });
      // Load any cached sync from IndexedDB (must run after createClient), then
      // preload the WASM and init the crypto store. The cache is best-effort: a
      // corrupted/blocked IndexedDB must NOT block login, so a startup failure is
      // swallowed and the SDK's degradable store falls back to in-memory.
      return from(
        store ? store.startup().catch(() => undefined) : Promise.resolve(),
      ).pipe(
        switchMap(() => preloadCryptoWasm()),
        switchMap(() => from(client.initRustCrypto())),
        tap(() => client.on(ClientEvent.Sync, this.onSync)),
        switchMap(() => from(client.startClient({ initialSyncLimit: 20 }))),
        tap(() => {
          // Publish only after a successful start; until now isInitialized stays false.
          this.client = client;
        }),
        catchError((err) => {
          client.off(ClientEvent.Sync, this.onSync);
          client.stopClient();
          this._syncState.set(null);
          this.secretStorageKeys.clear();
          this.destroySyncStore(); // release the store opened for this failed boot
          return throwError(() => err);
        }),
        map(() => void 0),
      );
    });
  }

  /** Restore a persisted session on app start, if one exists. */
  restore(): Observable<boolean> {
    return this.storage
      .load()
      .pipe(
        switchMap((session) =>
          session ? this.init(session).pipe(map(() => true)) : of(false),
        ),
      );
  }

  /** Stop syncing and tear down the client (without clearing the session). */
  stop(): Observable<void> {
    return defer(() => {
      this.teardown();
      return of(void 0);
    });
  }

  /**
   * Stop the client and DELETE its persistent stores (sync + crypto IndexedDB),
   * then drop the reference and forget the 4S key. For logout — unlike {@link stop}
   * it wipes local account data so a different user on the device can't read the
   * prior account's keys/cache. Best-effort: a store-clear failure still tears down.
   */
  reset(): Observable<void> {
    return defer(() => {
      const client = this.client;
      if (!client) {
        this._syncState.set(null);
        this.secretStorageKeys.clear();
        this.destroySyncStore();
        return of(void 0);
      }
      client.off(ClientEvent.Sync, this.onSync);
      client.stopClient(); // clearStores must run with the client stopped
      return from(client.clearStores()).pipe(
        catchError(() => of(void 0)),
        finalize(() => {
          this.client = null;
          this._syncState.set(null);
          this.secretStorageKeys.clear();
          this.destroySyncStore(); // close the now-emptied store's connection
        }),
        map(() => void 0),
      );
    });
  }

  /**
   * Build a persistent IndexedDB sync store scoped to the account, or null when
   * IndexedDB is unavailable (non-browser / unit tests) so the SDK falls back to
   * its in-memory store. {@link reset} clears the store's database on logout.
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
   * Synchronous teardown shared by stop() and init()'s re-entry guard: detach the
   * sync listener, stop the client, drop the reference, and forget the 4S key.
   */
  private teardown(): void {
    if (this.client) {
      this.client.off(ClientEvent.Sync, this.onSync);
      this.client.stopClient();
      this.client = null;
    }
    this.destroySyncStore();
    this._syncState.set(null);
    this.secretStorageKeys.clear();
  }

  /**
   * Close the sync store's IndexedDB connection and release its in-memory copy,
   * so a stop()/re-login doesn't leak connections (and a later open of the same
   * `dbName` can't block on a stale handle). Best-effort.
   */
  private destroySyncStore(): void {
    const store = this.syncStore;
    if (store) {
      this.syncStore = null;
      void Promise.resolve()
        .then(() => store.destroy())
        .catch(() => undefined);
    }
  }
}
