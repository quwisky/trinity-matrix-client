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
  isValidAuthMetadata,
  ClientEvent,
  EventStatus,
  HttpApiEvent,
  RoomEvent,
  SyncState,
  type AccessTokens,
  type ICreateClientOpts,
  type MatrixError,
  type MatrixEvent,
  type Room,
  type SyncStateData,
} from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import {
  Observable,
  Subject,
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
  CryptoStoreKeyService,
  HostNetworkPolicyService,
  SessionStorageService,
  deleteDatabase,
} from '@trinity/platform-native';
import {
  ProjectionRuntime,
  type ProjectionLease,
} from '@trinity/runtime/projection';
import {
  checkIssuerDiscovery,
  MatrixSession,
  type OidcSessionBinding,
  preloadCryptoWasm,
  rustCryptoStoreDbNames,
  syncStoreDbName,
  syncStoreIndexedDbName,
} from '@trinity/util/matrix';
import { SecretStorageKeyHolder } from './secret-storage-key-holder';
import { roomEncryptionRepair } from './room-encryption-repair';
import {
  clientHasOutgoingWork,
  clientPendingTexts,
  pauseClientSync,
  resendWaitingEchoes,
  waitingEchoCount,
  type PendingTextMessage,
} from './outgoing-work';
import {
  MatrixClientStartupError,
  classifyCryptoStartupFailure,
  expectedClientStartFailure,
  isRecord,
  type PersistedAccountStartOutcome,
} from './account-start-failure';

export type { PersistedAccountStartOutcome } from './account-start-failure';

/**
 * Default deadline for ordinary Matrix HTTP requests made by an account client. The
 * matrix-js-sdk patch's refresh-token grant abort (`REFRESH_TOKEN_GRANT_TIMEOUT_MS` in
 * `patches/matrix-js-sdk@43.0.0.patch`) mirrors this value and must change with it; the
 * spec pins the two together.
 */
export const MATRIX_REQUEST_TIMEOUT_MS = 30_000;

/** Where matrix-js-sdk discovers an OAuth account's provider (`MatrixClient.getAuthMetadata`). */
const AUTH_METADATA_PATH = '/_matrix/client/v1/auth_metadata';

/** Sync states that mean the homeserver could not be reached. */
const DISCONNECTED: ReadonlySet<SyncState> = new Set([
  SyncState.Reconnecting,
  SyncState.Error,
  SyncState.Catchup,
]);

/** Whether an endpoint names the same URL once parsed; anything unparseable does not. */
function sameEndpoint(a: unknown, b: string): boolean {
  try {
    return typeof a === 'string' && new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/**
 * Whether a sync state reports a sync completed with the homeserver. The SDK also emits
 * PREPARED for the sync it replays from its IndexedDB cache (`fromCache`), which can be
 * minutes stale, so that one does not count.
 */
export function isServerSync(
  state: SyncState | null,
  data?: Pick<SyncStateData, 'fromCache'> | null,
): boolean {
  return (
    state === SyncState.Syncing ||
    (state === SyncState.Prepared && !data?.fromCache)
  );
}

/** Resource ceiling for the first production Projection Runtime adapter. */
export const MATRIX_SYNC_PROJECTION_BASELINE = {
  listenerCountPerLiveAccount: 1,
  maxRetainedBytesPerLiveAccount:
    (SyncState.Reconnecting.length + SyncState.Prepared.length) * 2,
} as const;

export type PersistedAccountActivation = 'activate' | 'background';

/** One signed-in account's live client + the per-account state bound to it. */
interface AccountClient {
  readonly userId: string;
  readonly client: MatrixClient;
  /**
   * This account's Rust crypto-store `cryptoDatabasePrefix` (undefined for a migrated
   * legacy account on the SDK default). Retained so a logout wipe deletes THIS account's
   * crypto IndexedDB: otherwise the real store is orphaned and a later fresh login (new
   * device id, same userId-derived prefix) reopens a store with a mismatched device id.
   */
  readonly cryptoPrefix: string | undefined;
  /** Whether its crypto store is keyed (false for a store created before store keys). */
  readonly cryptoStoreEncrypted: boolean;
  /** The account's persistent sync store, retained so its IndexedDB can be closed. */
  readonly syncStore: IndexedDBStore | null;
  /** This account's coarse sync state (null until its first sync transition). */
  readonly syncState: WritableSignal<SyncState | null>;
  /** How many of its messages wait to be sent by themselves; see {@link waitingEchoCount}. */
  readonly waitingCount: WritableSignal<number>;
  /** Its `RoomEvent.LocalEchoUpdated` listener, which keeps {@link waitingCount} current. */
  readonly onLocalEchoUpdated: (
    event: MatrixEvent,
    room: Room,
    oldEventId?: string,
    oldStatus?: EventStatus | null,
  ) => void;
  /** Whether this client has completed a sync with its homeserver ({@link isServerSync}). */
  readonly serverSynced: WritableSignal<boolean>;
  /** Whether this client has prepared its rooms, from its sync cache or its homeserver. */
  readonly roomsPrepared: WritableSignal<boolean>;
  /** Projection Runtime lease owning sync-state attachment and reset. */
  readonly syncProjection: ProjectionLease;
  /** Its `HttpApiEvent.SessionLoggedOut` listener (server-side token revocation). */
  readonly onLoggedOut: (err: MatrixError) => void;
  /** Its own 4S key holder, wired into this client's crypto callbacks. */
  readonly holder: SecretStorageKeyHolder;
  /** Room keys the SDK last reported as waiting for backup upload; null before any report. */
  readonly backupKeysRemaining: () => number | null;
}

/**
 * Which client a set of token options is for: one this service started (whose refreshes
 * move the account's tracked pair while it owns it) or a detached one (persist only).
 */
type TokenRefreshOwner =
  | { readonly kind: 'started'; readonly client: () => MatrixClient | null }
  | { readonly kind: 'detached' };

/**
 * Holds back the hard-logout wipe for one account while a deletion request is in flight:
 * a non-soft `M_UNKNOWN_TOKEN` then only stops the client and is recorded.
 */
export interface ServerLogoutHold {
  /** Whether the server revoked the account's token while held. */
  readonly tokenDied: () => boolean;
  /** False once released, or once the account left this device and took its holds with it. */
  readonly isHeld: () => boolean;
  /**
   * `deleted: true` hands what follows to the deletion cleanup; `deleted: false` replays a
   * recorded logout through the ordinary hard path.
   */
  release(outcome: { readonly deleted: boolean }): void;
}

/** What the homeserver says about one account's token: accepted, refused as gone, or no answer. */
export type AccountServerStatus = 'active' | 'gone' | 'unreachable';

interface LogoutHoldState {
  readonly holds: Set<object>;
  readonly listeners: Set<() => void>;
  readonly signedInAgain: Set<() => void>;
  died: MatrixError | null;
  deleted: boolean;
}

/** An access token the SDK refreshed for one account, published after storage accepted it. */
export interface AccessTokenRotation {
  readonly userId: string;
  readonly accessToken: string;
}

/**
 * Owns the live matrix-js-sdk clients and their lifecycle: a registry of accounts, all
 * syncing, with one **active**. {@link instance} returns the active account's client.
 *
 * Lifecycle per account (see apps/docs-developers/src/content/docs/architecture/matrix-integration.md):
 *   createClient -> initRustCrypto({ cryptoDatabasePrefix, storageKey }) -> startClient()
 *
 * Components must NOT import matrix-js-sdk directly; go through this service and the
 * feature services layered on top.
 */
@Injectable({ providedIn: 'root' })
export class MatrixClientService {
  private readonly storage = inject(SessionStorageService);
  private readonly storeKeys = inject(CryptoStoreKeyService);
  private readonly projections = inject(ProjectionRuntime);
  private readonly hostNetworkPolicy = inject(HostNetworkPolicyService);

  private readonly clients = new Map<string, AccountClient>();
  private readonly logoutHolds = new Map<string, LogoutHoldState>();
  /** Set by a session handover's {@link pauseSync}: a reconnect then resends nothing. */
  private syncPaused = false;

  /**
   * Tell the Electron main process which origins we legitimately talk to, so its CORS
   * shim (electron/src/cors.ts) is scoped to them instead of rewriting every remote https
   * response. Main cannot know them: the user picks homeservers at login. Called wherever
   * the live account set changes; a no-op off desktop.
   */
  private publishCorsOrigins(): void {
    const origins = [...this.clients.values()].map((a) => a.client.baseUrl);
    this.hostNetworkPolicy.replaceAllowedOrigins(origins);
  }

  /**
   * Declare ONE origin to the same shim, additively, before the account's client exists
   * and {@link publishCorsOrigins} can name it: `startClient()` issues
   * `/_matrix/client/versions`, the thread-support probe and the first `/sync` before it
   * resolves, so publishing only afterwards leaves all three blocked against a homeserver
   * whose proxy strips CORS headers (a failed `getVersions()` disables server-side threads
   * for the whole session). The post-start {@link publishCorsOrigins} still replaces the
   * set, so removals keep applying.
   */
  private allowCorsOrigin(origin: string): void {
    this.hostNetworkPolicy.allowOrigin(origin);
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

  private readonly _accessTokenRotations = new Subject<AccessTokenRotation>();
  /**
   * Access tokens the SDK refreshed (OAuth sessions only), each published once storage has
   * accepted the new pair, and only while the refreshing client is still the account's live
   * or starting client. Never replays; the push handoff rewrites its copy from it.
   */
  readonly accessTokenRotations: Observable<AccessTokenRotation> =
    this._accessTokenRotations.asObservable();

  /**
   * The access token Trinity last saw each OAuth account's client start with or persist,
   * with its expiry (epoch ms) when the server gave one, and whether the sign-in has a
   * refresh token. Moved to each refreshed pair once storage accepted it, before the
   * rotation is published. Read through {@link accessTokenExpiry}.
   *
   * `client` is the start the entry belongs to. Only that client's refreshes move it and
   * only its teardown drops it: a refresh from a replaced or torn-down client, or a
   * teardown racing another start for the account, leaves it alone.
   */
  private readonly oauthTokens = new Map<
    string,
    {
      readonly client: MatrixClient;
      readonly accessToken: string;
      readonly expiresAt: number | undefined;
      readonly refreshable: boolean;
    }
  >();

  /**
   * In-flight background store wipes started by {@link reset}/{@link remove}, keyed by
   * user id. Re-adding that account awaits its wipe first: the sync and Rust-crypto
   * IndexedDB names repeat across a same-account re-login, so opening either before the
   * pending delete finishes would block (or race) it.
   */
  private readonly wipes = new Map<string, Promise<void>>();

  /**
   * Starts that have not finished yet, keyed by user id; see {@link start} for why a second
   * start joins the first.
   */
  private readonly starting = new Map<string, Observable<AccountClient>>();

  /**
   * matrix-js-sdk's legacy-to-Rust migration store is process-global during
   * `initRustCrypto()`. Two Accounts entering that method together can observe the
   * other's half-initialized IndexedDB migration state. Serialize only that critical
   * section; sync-store startup and `startClient()` remain concurrent per Account.
   */
  private cryptoInitializationQueue: Promise<unknown> = Promise.resolve();

  /** Coarse sync state of the ACTIVE account (null until its first transition). */
  readonly syncState: Signal<SyncState | null> = computed(() => {
    // Depend on the account set too: re-adding the active user must re-bind to its fresh
    // per-account signal even when the active id is unchanged.
    this._accountIds();
    return this.active()?.syncState() ?? null;
  });

  /**
   * Whether the ACTIVE account's crypto store is encrypted at rest (null when none is
   * active). False for a store created before store keys existed: it stays as it is until
   * the account signs in again on this device, which creates a new, encrypted store.
   */
  readonly cryptoStoreEncrypted: Signal<boolean | null> = computed(() => {
    this._accountIds();
    return this.active()?.cryptoStoreEncrypted ?? null;
  });

  /**
   * `offline` once the active account's sync is erroring or reconnecting, else `online`
   * (including the pre-first-sync window, so a fresh start doesn't flash offline).
   */
  readonly connectivity = computed<'online' | 'offline'>(() => {
    const state = this.syncState();
    return state === SyncState.Error || state === SyncState.Reconnecting
      ? 'offline'
      : 'online';
  });

  /** How many messages of the ACTIVE account wait to go out once it reconnects. */
  readonly waitingCount: Signal<number> = computed(() => {
    this._accountIds();
    return this.active()?.waitingCount() ?? 0;
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

  /**
   * Whether `userId`'s live client has completed a sync with its homeserver since it
   * started. A PREPARED replayed from the IndexedDB cache does not count: it can be
   * minutes stale. Stays true through RECONNECTING, ERROR and STOPPED; a replacement
   * client starts false; false when no client is live for the account.
   */
  serverSynced(userId: string): boolean {
    // Re-bind after a same-id client replacement, like {@link syncState}.
    this._accountIds();
    return this.clients.get(userId)?.serverSynced() ?? false;
  }

  /**
   * Whether `userId`'s live client has prepared its rooms at least once: from the sync it
   * replays from its IndexedDB cache, or from its homeserver. False while the client is
   * still loading even its cache, and when no client is live for the account. Unlike
   * {@link serverSynced}, rooms from a cache can be minutes stale.
   */
  roomsPrepared(userId: string): boolean {
    this._accountIds();
    return this.clients.get(userId)?.roomsPrepared() ?? false;
  }

  /** The live client for a specific account, or null (e.g. per-account server logout). */
  clientFor(userId: string): MatrixClient | null {
    return this.clients.get(userId)?.client ?? null;
  }

  /**
   * When `accessToken` stops working (epoch ms), if it is the token Trinity last saw this
   * account's client start with or persist and the server gave it a lifetime. Undefined
   * for password and SSO tokens, a token without `expires_in`, and a token the client has
   * already replaced, so an expiry never travels with the wrong token.
   */
  accessTokenExpiry(userId: string, accessToken: string): number | undefined {
    const held = this.oauthTokens.get(userId);
    return held?.accessToken === accessToken ? held.expiresAt : undefined;
  }

  /**
   * Ask the SDK to refresh one live OAuth account's tokens now, joining a refresh already
   * in flight; the new pair is persisted and published through `onTokenRefresh`. Emits
   * whether new tokens were adopted. A refusal signs nothing out here: the account's next
   * request meets it. Cold and finite; never errors; false for an account that is not live,
   * not OAuth or without a refresh token.
   *
   * `timeoutMs` bounds the token grant this call starts, counted from the call; past it the
   * grant is aborted and fails like a network error. Without it the patched SDK's own bound
   * ({@link MATRIX_REQUEST_TIMEOUT_MS}, from the grant's start) applies. A refresh already
   * in flight keeps its own bound.
   */
  refreshAccessToken(
    userId: string,
    options: { readonly timeoutMs?: number } = {},
  ): Observable<boolean> {
    return defer(() => {
      const client = this.clients.get(userId)?.client;
      if (!client || !this.canRefreshAccessToken(userId)) return of(false);
      return from(client.http.refreshOAuthTokens(options));
    }).pipe(catchError(() => of(false)));
  }

  /**
   * Whether {@link refreshAccessToken} can refresh this account now: it is live, signed in
   * through OAuth and holds a refresh token.
   */
  canRefreshAccessToken(userId: string): boolean {
    return (
      this.clients.has(userId) &&
      this.oauthTokens.get(userId)?.refreshable === true
    );
  }

  /**
   * Whether removing this account's local keys would lose nothing: key backup is active
   * and no room key is still waiting to upload. `null` when the account is not live or
   * its crypto cannot answer, so the caller can warn without claiming a backup status.
   */
  roomKeysBackedUp(userId: string): Observable<boolean | null> {
    return defer(async () => {
      const account = this.clients.get(userId);
      const crypto = account?.client.getCrypto();
      if (!account || !crypto) {
        return null;
      }
      const version = await crypto.getActiveSessionBackupVersion();
      return version !== null && account.backupKeysRemaining() === 0;
    }).pipe(catchError(() => of(null)));
  }

  /**
   * An unstarted client for a stored session (no persistent store, no crypto, no sync),
   * for one-shot calls on a stored account whose client never started: `logout()` for an
   * OAuth account, whose tokens must still be revoked at its provider.
   *
   * `persistRefreshedTokens: false` keeps any token refresh in memory: for a client acting
   * on a device that is being replaced, whose tokens must never be saved over the new
   * device's.
   */
  detachedClient(
    session: MatrixSession,
    options: { readonly persistRefreshedTokens: boolean } = {
      persistRefreshedTokens: true,
    },
  ): MatrixClient {
    const { onTokenRefresh, ...tokens } = this.tokenOptions(session, {
      kind: 'detached',
    });
    return createClient({
      baseUrl: session.baseUrl,
      localTimeoutMs: MATRIX_REQUEST_TIMEOUT_MS,
      accessToken: session.accessToken,
      userId: session.userId,
      deviceId: session.deviceId,
      ...tokens,
      ...(options.persistRefreshedTokens && onTokenRefresh
        ? { onTokenRefresh }
        : {}),
    });
  }

  /**
   * Replace any signed-in accounts with this one and make it active; use {@link add} to
   * keep the others. Cold. The new client is only published once fully started: a failed
   * bootstrap cleans up and rethrows rather than leaving a half-initialized client.
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
              // A lost store key also needs a sign-in as a new device, which the re-auth
              // flow chooses when the key no longer reads back.
              if (
                error.failure === 'reauthentication-required' ||
                error.failure === 'crypto-store-key-lost'
              ) {
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

  /** Flag a user id as soft-logged-out (needs re-auth). Deduped; cleared by a successful (re-)start. */
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
   * Stop every live client's sync loop, and only that: crypto, and sends and uploads already
   * on their way, carry on. For a session handover, which waits for them and then calls
   * {@link stop}.
   */
  pauseSync(): void {
    this.syncPaused = true;
    for (const account of this.clients.values()) {
      pauseClientSync(account.client);
    }
  }

  /** Whether any live client still has a message or an upload on its way. */
  hasOutgoingWork(): boolean {
    return [...this.clients.values()].some((account) =>
      clientHasOutgoingWork(account.client),
    );
  }

  /**
   * Text messages the live clients have not got onto the homeserver. Read before {@link stop}:
   * the local echoes go with the clients.
   */
  pendingTextMessages(): readonly PendingTextMessage[] {
    return [...this.clients.values()].flatMap((account) =>
      clientPendingTexts(account.client, account.userId),
    );
  }

  /**
   * Ask the homeserver to invalidate every live account's device, best-effort.
   *
   * For the factory reset, which must work when the homeserver is unreachable, so each
   * logout is caught on the RAW promise rather than through `catchError`: the caller races
   * this against a timeout and `race` unsubscribes the loser, and a promise rejecting after
   * its subscriber closed reaches the global error handler, which would toast in the middle
   * of a deliberate wipe.
   *
   * Resolves once every attempt has settled; never errors. Does NOT tear the clients down,
   * so call it while they are still LIVE: `stop()` empties the registry this reads, and
   * calling it afterwards signs nothing out while looking identical from outside.
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

  /**
   * Hold the hard-logout wipe for `userId` until released. Deactivation revokes every token,
   * so a concurrent sync can see `M_UNKNOWN_TOKEN` before the deactivate response arrives.
   */
  holdServerLogout(
    userId: string,
    options: {
      readonly onTokenDied?: () => void;
      /** A sign-in after a soft logout succeeded, which a deleted account cannot do. */
      readonly onSignedInAgain?: () => void;
    } = {},
  ): ServerLogoutHold {
    let state = this.logoutHolds.get(userId);
    if (!state) {
      state = {
        holds: new Set(),
        listeners: new Set(),
        signedInAgain: new Set(),
        died: null,
        deleted: false,
      };
      this.logoutHolds.set(userId, state);
    }
    const held = state;
    const token = {};
    const listener = options.onTokenDied;
    const onSignedInAgain = options.onSignedInAgain;
    held.holds.add(token);
    if (listener) {
      held.listeners.add(listener);
    }
    if (onSignedInAgain) {
      held.signedInAgain.add(onSignedInAgain);
    }
    return {
      tokenDied: () => held.died !== null,
      isHeld: () =>
        held.holds.has(token) && this.logoutHolds.get(userId) === held,
      release: ({ deleted }) => {
        if (!held.holds.delete(token)) {
          return;
        }
        if (listener) {
          held.listeners.delete(listener);
        }
        if (onSignedInAgain) {
          held.signedInAgain.delete(onSignedInAgain);
        }
        held.deleted ||= deleted;
        if (held.holds.size > 0 || this.logoutHolds.get(userId) !== held) {
          return;
        }
        this.logoutHolds.delete(userId);
        if (held.died && !held.deleted) {
          this.handleServerLogout(userId, held.died);
        }
      },
    };
  }

  /** Ask the homeserver whether `userId`'s token still works, with that account's own client. */
  accountStatus(userId: string): Observable<AccountServerStatus> {
    return defer(async (): Promise<AccountServerStatus> => {
      const account = this.clients.get(userId);
      if (!account) {
        return 'unreachable';
      }
      try {
        await account.client.whoami();
        return 'active';
      } catch (err) {
        const errcode = (err as { errcode?: unknown } | null)?.errcode;
        return errcode === 'M_UNKNOWN_TOKEN' || errcode === 'M_USER_DEACTIVATED'
          ? 'gone'
          : 'unreachable';
      }
    });
  }

  /** The active account client, or null when none is signed in / active. */
  private active(): AccountClient | null {
    const id = this._activeUserId();
    return id ? (this.clients.get(id) ?? null) : null;
  }

  /**
   * Build a client from a session, bootstrap E2EE, start syncing, and register it (not
   * activated; the caller decides). On failure it tears the half-started client down and
   * rethrows.
   *
   * **Idempotent per account while in flight**, and independent of the caller's
   * subscription surviving. The callers are guards: the Router unsubscribes a guard whose
   * navigation is superseded, and the start chain (open IndexedDB, WASM, `initRustCrypto`,
   * `startClient`) is long enough that a deep link arriving mid-flight begins a second
   * start for the same account. Two `initRustCrypto` calls on one device open the same
   * crypto store twice, which produces device-key divergence.
   *
   * So a second `start()` for the same user id JOINS the first, and the shared chain is
   * `refCount: false` deliberately: losing the last subscriber must not cancel it, or a
   * cancelled navigation would leave a half-open store for the next login to collide with.
   * It always runs to the end and, if nothing consumed its result, rolls itself back (see
   * `rollback` in {@link startNew}).
   */
  private start(session: MatrixSession): Observable<AccountClient> {
    return defer(() => {
      const inFlight = this.starting.get(session.userId);
      if (inFlight) {
        return inFlight;
      }
      // Set by the tap BELOW the share: true exactly when some subscriber received the
      // account, which `startNew` uses to decide whether this start was wanted. A subscriber
      // count would not do: `firstValueFrom` unsubscribes on the value.
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
        // The entry is dropped above once the chain settles, so a FAILED start is never
        // replayed to a later caller.
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
   * bootstraps and registers the client. {@link start} owns the joining and cancellation.
   */
  private startNew(
    session: MatrixSession,
    consumed: () => boolean,
  ): Observable<AccountClient> {
    return defer(() => {
      // Replace any existing client for this account (re-add / re-auth) so a running client,
      // its Sync listener and its sync store are never orphaned, and its per-account
      // IndexedDB is never opened twice.
      if (this.clients.has(session.userId)) {
        this.removeInternal(session.userId, false);
      }
      let created: MatrixClient | null = null;
      let store: IndexedDBStore | null = null;
      let account: AccountClient | null = null;
      let syncProjection: ProjectionLease | null = null;
      const syncState = signal<SyncState | null>(null);
      let latestSyncState: SyncState | null = null;
      // Set when sync loses the homeserver; the next `Syncing` resends what failed meanwhile.
      // Not the previous state alone: an app that starts offline comes back through `Prepared`.
      let disconnected = false;
      // One resend run at a time, so a second reconnect mid-run cannot overtake a room's order.
      let resending = Promise.resolve();
      const serverSynced = signal(false);
      let latestServerSynced = false;
      const roomsPrepared = signal(false);
      let latestRoomsPrepared = false;
      const waitingCount = signal(0);
      // Only an echo entering or leaving NOT_SENT changes the count; most updates are an ordinary
      // send passing through other states, and the scan walks every room and thread.
      const onLocalEchoUpdated = (
        event: MatrixEvent,
        _room: Room,
        _oldEventId?: string,
        oldStatus?: EventStatus | null,
      ): void => {
        if (
          event.status === EventStatus.NOT_SENT ||
          oldStatus === EventStatus.NOT_SENT
        ) {
          waitingCount.set(waitingEchoCount(created!));
        }
      };
      const onLoggedOut = (err: MatrixError): void =>
        this.handleServerLogout(session.userId, err);
      // Not detached on teardown: it only updates this start's own counter. Null until the
      // SDK's first report, so an unknown upload state never reads as "all backed up".
      let backupKeysRemaining: number | null = null;
      const onBackupKeysRemaining = (remaining: number): void => {
        backupKeysRemaining = remaining;
      };
      // Wired only into THIS client's callbacks so a background account's key operation
      // can't read or overwrite another account's key.
      const holder = new SecretStorageKeyHolder();
      /**
       * Undo whatever this attempt managed to do. Driven from `finalize`, so it covers the
       * error path AND the cancelled one: an unsubscribed start still reaches the end, and
       * without this its client would sync on, unreachable, with its crypto store open.
       */
      const rollback = (): void => {
        if (account) {
          // It finished after its caller had gone: use the normal removal path.
          if (this.clients.get(session.userId) === account) {
            this.removeInternal(session.userId, false);
          }
          return;
        }
        syncProjection?.release();
        created?.off(HttpApiEvent.SessionLoggedOut, onLoggedOut);
        created?.off(RoomEvent.LocalEchoUpdated, onLocalEchoUpdated);
        created?.stopClient();
        holder.clear();
        this.forgetOAuthTokens(session.userId, created);
        this.closeStore(store);
      };
      return from(this.wipes.get(session.userId) ?? Promise.resolve()).pipe(
        switchMap(() => {
          store = this.createSyncStore(session.userId);
          // Before the client is built: startClient() resolves only after its first requests.
          this.allowCorsOrigin(session.baseUrl);
          created = createClient({
            baseUrl: session.baseUrl,
            // Without a client-level deadline, a socket that accepts a request and never
            // answers leaves every downstream busy/finalize path pending. Long-poll sync
            // calls pass their own larger timeout.
            localTimeoutMs: MATRIX_REQUEST_TIMEOUT_MS,
            accessToken: session.accessToken,
            userId: session.userId,
            deviceId: session.deviceId,
            ...this.tokenOptions(session, {
              kind: 'started',
              client: () => created,
            }),
            ...(store ? { store } : {}),
            // Lets the crypto stack read/write 4S with the recovery key unlocked during
            // setup/recovery (held only in memory).
            cryptoCallbacks: {
              getSecretStorageKey: holder.getSecretStorageKey,
              cacheSecretStorageKey: holder.cacheSecretStorageKey,
            },
          });
          if (session.oidc) {
            this.oauthTokens.set(session.userId, {
              client: created,
              accessToken: session.accessToken,
              expiresAt: session.accessTokenExpiresAt,
              refreshable: !!session.refreshToken,
            });
          }
          // A corrupt or blocked IndexedDB must NOT block login.
          return from(
            store ? store.startup().catch(() => undefined) : Promise.resolve(),
          );
        }),
        switchMap(() =>
          preloadCryptoWasm().pipe(catchError(classifyCryptoStartupFailure)),
        ),
        switchMap(() => from(this.storeKey(session))),
        switchMap((storageKey) =>
          // An unset prefix (migrated legacy account) means the SDK default store, which
          // keeps its existing keys.
          from(
            this.initializeCrypto(created!, session.cryptoPrefix, storageKey),
          ).pipe(catchError(classifyCryptoStartupFailure)),
        ),
        tap(() => {
          const client = created!;
          const repairEncryption = roomEncryptionRepair(client);
          syncProjection = this.projections.activate({
            id: 'matrix.sync-state',
            scope: { kind: 'exact-account', accountId: session.userId },
            attach: (invalidate) => {
              const onSync = (
                state: SyncState,
                _previous: SyncState | null,
                data?: SyncStateData,
              ): void => {
                if (DISCONNECTED.has(state)) {
                  disconnected = true;
                } else if (state === SyncState.Syncing && disconnected) {
                  disconnected = false;
                  // Removal, stop() and a handover pause all end a run between two sends.
                  const live = (): boolean =>
                    !this.syncPaused &&
                    this.clients.get(session.userId)?.client === client;
                  resending = resending
                    .then(() => resendWaitingEchoes(client, live))
                    .catch((error: unknown) => {
                      console.warn(
                        "Couldn't resend the messages that failed offline.",
                        error,
                      );
                    });
                }
                latestSyncState = state;
                latestServerSynced ||= isServerSync(state, data);
                latestRoomsPrepared ||=
                  state === SyncState.Prepared || state === SyncState.Syncing;
                repairEncryption(state);
                invalidate();
              };
              client.on(ClientEvent.Sync, onSync);
              return () => client.off(ClientEvent.Sync, onSync);
            },
            reconcile: ({ publish }) =>
              defer(() => {
                publish(() => {
                  syncState.set(latestSyncState);
                  serverSynced.set(latestServerSynced);
                  roomsPrepared.set(latestRoomsPrepared);
                });
                return of(void 0);
              }),
            reset: () => {
              syncState.set(null);
              serverSynced.set(false);
              roomsPrepared.set(false);
            },
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
          created!.on(RoomEvent.LocalEchoUpdated, onLocalEchoUpdated);
          created!.on(
            CryptoEvent.KeyBackupSessionsRemaining,
            onBackupKeysRemaining,
          );
        }),
        switchMap(() =>
          from(
            // Lazy members: a first sync carries only the members its events name; a room
            // loads the rest when it is opened, observed in settings or upgraded.
            created!.startClient({
              initialSyncLimit: 20,
              threadSupport: true,
              lazyLoadMembers: true,
            }),
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
            cryptoStoreEncrypted: session.cryptoStoreKeyed === true,
            syncStore: store,
            syncState,
            waitingCount,
            onLocalEchoUpdated,
            serverSynced,
            roomsPrepared,
            syncProjection,
            onLoggedOut,
            holder,
            backupKeysRemaining: () => backupKeysRemaining,
          };
          account = started;
          this.clients.set(session.userId, started);
          // A logout recorded for a replaced client must not end this one; a token that is
          // still dead reports itself again.
          const held = this.logoutHolds.get(session.userId);
          if (held) {
            held.died = null;
          }
          this._accountIds.set([...this.clients.keys()]);
          this.publishCorsOrigins();
          // A successful (re-)start means re-auth restored the account.
          const signedInAgain = this._softLoggedOut().includes(session.userId);
          this.clearSoftLoggedOut(session.userId);
          if (signedInAgain) {
            const held = this.logoutHolds.get(session.userId);
            for (const notify of [...(held?.signedInAgain ?? [])]) {
              notify();
            }
          }
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
        // Covers error, completion and unsubscription; the error still propagates.
        finalize(() => {
          if (!consumed()) {
            rollback();
          }
        }),
      );
    });
  }

  /**
   * What lets matrix-js-sdk 43 own an OAuth-native session's tokens: it refreshes them on
   * a 401 or near expiry, and `logout()` revokes them at the provider instead of calling
   * `POST /logout`. Without `oauthClientId` the SDK does not refresh at all, and the first
   * 401 becomes a hard logout that deletes the account's crypto store.
   *
   * `onTokenRefresh` persists for THIS account only and returns the write: the SDK awaits
   * it before adopting the new pair, so a failed write fails the refresh and the old
   * tokens stay in memory.
   *
   * The write is a compare-and-swap on the sign-in the session came from (its
   * {@link MatrixSession.lineage}): storage applies it only while the account's record still
   * holds that sign-in. So a retired, rolled-back, stopped or removed client still saves the
   * pair it rotated while its sign-in is the stored one (with refresh-token rotation those
   * are the only valid next tokens), and a client a new sign-in replaced never writes over
   * the new session.
   *
   * A `started` client's refresh then moves the tracked pair and publishes the rotation,
   * only while that client still owns the tracked pair (it is live or starting). A
   * `detached` client is never the live client, so its refresh is only persisted.
   */
  private tokenOptions(
    session: MatrixSession,
    owner: TokenRefreshOwner,
  ): Pick<
    ICreateClientOpts,
    'refreshToken' | 'oauthClientId' | 'onTokenRefresh' | 'fetchFn'
  > {
    return {
      ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
      ...(session.oidc
        ? {
            oauthClientId: session.oidc.clientId,
            fetchFn: this.pinnedProviderFetch(session, session.oidc),
            onTokenRefresh: (tokens: AccessTokens): Promise<void> =>
              firstValueFrom(
                this.storage.updateTokens(
                  session.userId,
                  session.lineage,
                  tokens.accessToken,
                  tokens.refreshToken,
                  tokens.expiry?.getTime(),
                ),
              ).then(() => {
                if (owner.kind === 'detached') {
                  return;
                }
                // Checked after the write: the client may have been replaced meanwhile.
                const client = owner.client();
                const tracked = this.oauthTokens.get(session.userId);
                if (!client || tracked?.client !== client) {
                  return;
                }
                // Before publishing, so a reader of the rotation finds the new expiry.
                this.oauthTokens.set(session.userId, {
                  ...tracked,
                  accessToken: tokens.accessToken,
                  expiresAt: tokens.expiry?.getTime(),
                });
                this._accessTokenRotations.next({
                  userId: session.userId,
                  accessToken: tokens.accessToken,
                });
              }),
          }
        : {}),
    };
  }

  /**
   * The client's fetch, refusing auth metadata that names another provider than the one
   * the account signed in with, so the SDK never refreshes or revokes at a moved endpoint.
   * A refused answer fails as a network error would, and the SDK retries later.
   *
   * A binding saved before endpoints were pinned accepts metadata naming its issuer that
   * the issuer's own document does not contradict, and pins it only once that document
   * was fetched and agreed.
   */
  private pinnedProviderFetch(
    session: MatrixSession,
    signedIn: OidcSessionBinding,
  ): typeof globalThis.fetch {
    let binding = signedIn;
    return async (input, init) => {
      const response = await globalThis.fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        !response.ok ||
        url.origin !== new URL(session.baseUrl).origin ||
        !url.pathname.replace(/\/{2,}/g, '/').endsWith(AUTH_METADATA_PATH)
      ) {
        return response;
      }
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      const live = isRecord(body) ? body : {};
      const issuer = live['issuer'];
      const tokenEndpoint = live['token_endpoint'];
      const revocationEndpoint = live['revocation_endpoint'];
      if (issuer !== binding.issuer) {
        throw new TypeError('The homeserver names another sign-in provider.');
      }
      if (!binding.tokenEndpoint) {
        // Invalid metadata passes through: the SDK refuses it itself.
        if (isValidAuthMetadata(body)) {
          const verified = await checkIssuerDiscovery(body).catch(
            () => undefined,
          );
          if (verified === undefined) {
            throw new TypeError(
              "The homeserver's sign-in provider does not match the issuer's own metadata.",
            );
          }
          // Without the issuer's own document nothing confirms the endpoints: use them
          // for this refresh only, and try pinning again on the next client.
          if (verified) {
            binding = { ...binding, ...verified };
            await firstValueFrom(
              this.storage.updateOidcBinding(
                session.userId,
                session.lineage,
                binding,
              ),
            ).catch(() => undefined);
          }
        }
        return response;
      }
      if (
        !sameEndpoint(tokenEndpoint, binding.tokenEndpoint) ||
        (binding.revocationEndpoint !== undefined &&
          revocationEndpoint !== undefined &&
          !sameEndpoint(revocationEndpoint, binding.revocationEndpoint))
      ) {
        throw new TypeError('The homeserver names another sign-in provider.');
      }
      return response;
    };
  }

  /** Drop an account's tracked OAuth pair if it still belongs to this client. */
  private forgetOAuthTokens(userId: string, client: MatrixClient | null): void {
    if (client && this.oauthTokens.get(userId)?.client === client) {
      this.oauthTokens.delete(userId);
    }
  }

  /**
   * The key a keyed store opens with, or null for a store created without one. A keyed
   * store is never opened without its key. A missing key fails as `crypto-store-key-lost`:
   * only a sign-in as a new device (a new store and key) recovers the account here. A key
   * that cannot be reached right now (a locked keyring) fails as
   * `secure-storage-unavailable`, to be retried, so an outage never replaces the store.
   */
  private async storeKey(session: MatrixSession): Promise<Uint8Array | null> {
    if (!session.cryptoStoreKeyed || !session.cryptoPrefix) {
      return null;
    }
    const read = await this.storeKeys
      .read(session.cryptoPrefix)
      .catch(() => ({ kind: 'unavailable' }) as const);
    if (read.kind === 'present') {
      return read.key;
    }
    throw read.kind === 'missing'
      ? new MatrixClientStartupError(
          'crypto-store-key-lost',
          new Error('The crypto store key is missing on this device.'),
        )
      : new MatrixClientStartupError(
          'secure-storage-unavailable',
          new Error('Secure storage is unavailable right now.'),
        );
  }

  /**
   * Open the account's Rust crypto store, with its store key when it has one. A store
   * created without a key is opened without one: the crypto WASM refuses to open an
   * existing unencrypted store with a key and cannot encrypt it in place.
   */
  private initializeCrypto(
    client: MatrixClient,
    cryptoDatabasePrefix: string | undefined,
    storageKey: Uint8Array | null,
  ): Promise<void> {
    const result = this.cryptoInitializationQueue.then(() =>
      client.initRustCrypto({
        cryptoDatabasePrefix,
        ...(storageKey ? { storageKey } : {}),
      }),
    );
    this.cryptoInitializationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Stop and drop every client (no store deletion), and forget the 4S keys. */
  private teardownAll(): void {
    this.syncPaused = false;
    for (const account of this.clients.values()) {
      account.syncProjection.release();
      account.client.off(HttpApiEvent.SessionLoggedOut, account.onLoggedOut);
      account.client.off(
        RoomEvent.LocalEchoUpdated,
        account.onLocalEchoUpdated,
      );
      account.client.stopClient();
      account.holder.clear();
      this.closeStore(account.syncStore);
      // A start still in flight keeps its pair: it is not torn down here.
      this.forgetOAuthTokens(account.userId, account.client);
    }
    this.clients.clear();
    this._accountIds.set([]);
    this.publishCorsOrigins();
    this._activeUserId.set(null);
    this._softLoggedOut.set([]);
    this.logoutHolds.clear();
  }

  /**
   * Remove one account: stop it, drop it from the map, repoint active if it was
   * active, and either wipe (logout) or just close (switch-away) its stores.
   */
  private removeInternal(userId: string, wipe: boolean): void {
    this.clearSoftLoggedOut(userId);
    if (wipe) {
      this.logoutHolds.delete(userId);
    }
    const account = this.clients.get(userId);
    // Only the removed client's pair: a start in flight for this account keeps its own.
    this.forgetOAuthTokens(userId, account?.client ?? null);
    if (!account) {
      if (wipe) {
        // Must still wipe when there is nothing to stop (a soft-logged-out account, or one
        // whose background warm-up failed): the caller deletes the registry record moments
        // later, and that record is the only thing naming this account's crypto store.
        this.wipeStoresByName(userId);
      }
      return;
    }
    account.syncProjection.release();
    account.client.off(HttpApiEvent.SessionLoggedOut, account.onLoggedOut);
    account.client.off(RoomEvent.LocalEchoUpdated, account.onLocalEchoUpdated);
    account.client.stopClient(); // clearStores must run with the client stopped
    account.holder.clear();
    this.clients.delete(userId);
    this._accountIds.set([...this.clients.keys()]);
    this.publishCorsOrigins();
    if (this._activeUserId() === userId) {
      this._activeUserId.set(this.clients.keys().next().value ?? null);
    }
    if (wipe) {
      // Pass the account's OWN cryptoDatabasePrefix so the Rust store deleted is this
      // account's (`${prefix}::matrix-sdk-crypto`), not the SDK default: omitting it orphans
      // the real store and breaks a later fresh login with a device-id mismatch.
      // The crypto delete can block ~25s (the WASM store connection releases only on GC),
      // so it is a tracked BACKGROUND wipe; a re-add of the same account awaits it.
      // Best-effort: a failure still leaves the client removed.
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
   * hands `clearStores`). Without a record only the
   * sync-store name is known; the SDK-default crypto pair may belong to a migrated legacy
   * account, so it is left for the cold-start orphan sweep rather than guessed at.
   *
   * Best-effort and bounded (`deleteDatabase` settles even when a connection blocks it),
   * and tracked like the live wipe so a re-add awaits it.
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
   * Track an in-flight store wipe, pruning the entry once it settles (unless a newer wipe
   * replaced it) so the map doesn't grow across logout/login cycles.
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
   * logout (`soft_logout: true`) keeps the device and stores: the client stops without
   * wiping and is marked {@link softLoggedOut}, so re-authenticating (its registry entry
   * and crypto-store prefix are preserved) restores it. A **hard** logout (device deleted
   * server-side) wipes the account's stores and drops its registry entry. Either way the
   * other accounts keep running and the active pointer moves to a survivor (or null).
   */
  private handleServerLogout(userId: string, err: MatrixError): void {
    if (!this.clients.has(userId)) {
      return; // already torn down
    }
    const soft =
      (err.data as { soft_logout?: boolean } | undefined)?.soft_logout === true;
    const held = soft ? undefined : this.logoutHolds.get(userId);
    if (held) {
      this.clients.get(userId)?.client.stopClient();
      held.died ??= err;
      for (const listener of [...held.listeners]) {
        listener();
      }
      return;
    }
    if (soft) {
      // Keep the stores and registry entry for re-auth, but drop the dead token so a
      // restart's restore skips it instead of resurrecting a failing ghost account.
      this.removeInternal(userId, false);
      this.storage
        .invalidateToken(userId)
        .subscribe({ error: () => undefined });
      this.markSoftLoggedOut(userId);
    } else {
      // The device is gone server-side: wipe locally and forget the account.
      this.removeInternal(userId, true);
      this.storage.remove(userId).subscribe({ error: () => undefined });
    }
    // removeInternal repoints in memory by Map order, storage.remove by array order; without
    // this a restart could restore a different account than the UI shows.
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
   * Build a persistent IndexedDB sync store scoped to the account, or null when IndexedDB
   * is unavailable (unit tests) so the SDK falls back to its in-memory store.
   */
  private createSyncStore(userId: string): IndexedDBStore | null {
    if (typeof globalThis.indexedDB === 'undefined') {
      return null;
    }
    return new IndexedDBStore({
      indexedDB: globalThis.indexedDB,
      // Per-account database so accounts on one device don't share a cache.
      // The SDK prepends `matrix-js-sdk:` to this; anything deleting the database by name
      // must use syncStoreIndexedDbName.
      dbName: syncStoreDbName(userId),
    });
  }

  /**
   * Close a specific IndexedDB sync-store instance. Taken by value so a long-running
   * background wipe destroys the store it started for, never a newer one a re-login opens
   * while the wipe is pending.
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
