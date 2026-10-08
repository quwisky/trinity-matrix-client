import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import {
  ClientEvent,
  ConnectionError,
  HttpApiEvent,
  MemoryStore,
  SyncState,
  TokenRefreshError,
  createClient,
} from 'matrix-js-sdk';
import type { MatrixClient } from 'matrix-js-sdk';
import { Subject, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MATRIX_SYNC_PROJECTION_BASELINE,
  MatrixClientService,
} from './matrix-client.service';
import { SessionStorageService } from '@trinity/platform-native';
import {
  ProjectionRuntime,
  type ProjectionReadiness,
} from '@trinity/runtime/projection';
import { SecretStorageKeyHolder } from './secret-storage-key-holder';
import { desktopBridgeFixture } from '@trinity/testing';
import type { MatrixSession } from '@trinity/util/matrix';

// A controllable fake sync store (the real IndexedDBStore needs a browser IDB).
const storeMock = vi.hoisted(() => ({ startup: vi.fn(), destroy: vi.fn() }));

// Keep the real enums (ClientEvent/SyncState) but stub the client factory + store.
vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>();
  return {
    ...actual,
    createClient: vi.fn(),
    IndexedDBStore: class {
      startup = storeMock.startup;
      destroy = storeMock.destroy;
    },
  };
});

// The WASM preload is a no-op in tests (no real crypto engine). preloadCryptoWasm
// now lives in @trinity/util/matrix; partial-mock so its other exports stay real.
vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
});

const SESSION = {
  baseUrl: 'https://hs.example',
  userId: '@me:hs',
  deviceId: 'DEV',
  accessToken: 'tok',
};
const SESSION_B = {
  baseUrl: 'https://other.example',
  userId: '@you:other',
  deviceId: 'DEV2',
  accessToken: 'tok2',
};
// An OIDC ("next-gen auth") session: refresh token + expiry + provider binding.
const OIDC_SESSION = {
  ...SESSION,
  refreshToken: 'refresh-tok',
  accessTokenExpiresAt: 1234,
  oidc: {
    issuer: 'https://op',
    clientId: 'client-1',
    redirectUri: 'https://app/sso-callback',
    idTokenClaims: {
      iss: 'https://op',
      sub: 'u',
      aud: 'client-1',
      exp: 1,
      iat: 0,
    },
  },
};

function fakeClient(baseUrl = 'https://hs.example') {
  return {
    baseUrl,
    on: vi.fn(),
    off: vi.fn(),
    initRustCrypto: vi.fn().mockResolvedValue(undefined),
    startClient: vi.fn().mockResolvedValue(undefined),
    stopClient: vi.fn(),
    clearStores: vi.fn().mockResolvedValue(undefined),
    getCrypto: vi.fn().mockReturnValue(undefined),
  };
}

function setup() {
  TestBed.configureTestingModule({
    providers: [MatrixClientService, MockProvider(SessionStorageService)],
  });
  const svc = TestBed.inject(MatrixClientService);
  const storage = TestBed.inject(SessionStorageService);
  const projections = TestBed.inject(ProjectionRuntime);
  // Default: no persisted session (mirrors the original hand-rolled stub); the
  // save/clear observables aren't exercised by these paths.
  vi.mocked(storage.load).mockReturnValue(of(null));
  // A wipe of a non-live account reads its registry record for the crypto prefix.
  vi.mocked(storage.record).mockReturnValue(of(null));
  return { svc, storage, projections };
}

describe('MatrixClientService', () => {
  let clearHolder: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.mocked(createClient).mockReset();
    storeMock.startup.mockReset().mockResolvedValue(undefined);
    storeMock.destroy.mockReset().mockResolvedValue(undefined);
    // Each account owns its own 4S holder; spy on the class so tests can assert the
    // key is cleared on teardown/failure without reaching into internal instances.
    clearHolder = vi.spyOn(SecretStorageKeyHolder.prototype, 'clear');
  });

  afterEach(() => {
    clearHolder.mockRestore();
    vi.unstubAllGlobals();
  });

  it('creates the client, inits crypto, starts, and publishes on success', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();

    await firstValueFrom(svc.init(SESSION));

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://hs.example',
        accessToken: 'tok',
        userId: '@me:hs',
        deviceId: 'DEV',
        localTimeoutMs: 30_000,
      }),
    );
    expect(client.initRustCrypto).toHaveBeenCalledOnce();
    // No per-account prefix on this session → the SDK default store prefix.
    expect(client.initRustCrypto).toHaveBeenCalledWith({
      cryptoDatabasePrefix: undefined,
    });
    expect(client.startClient).toHaveBeenCalledOnce();
    expect(svc.isInitialized).toBe(true);
    expect(svc.instance).toBe(client);
  });

  it('scopes the crypto store to the account via cryptoDatabasePrefix', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();

    await firstValueFrom(
      svc.init({ ...SESSION, cryptoPrefix: 'trinity-crypto:@me:hs' }),
    );

    expect(client.initRustCrypto).toHaveBeenCalledWith({
      cryptoDatabasePrefix: 'trinity-crypto:@me:hs',
    });
  });

  it('hands an OIDC session to the SDK token manager', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();

    await firstValueFrom(svc.init(OIDC_SESSION));

    const opts = vi.mocked(createClient).mock.calls[0][0];
    // Without oauthClientId matrix-js-sdk 43 refuses to refresh, and the first 401 becomes
    // a hard logout that deletes the crypto store.
    expect(opts).toMatchObject({
      refreshToken: 'refresh-tok',
      oauthClientId: 'client-1',
    });
    expect(typeof opts.onTokenRefresh).toBe('function');
  });

  it('persists refreshed tokens for its own account and hands the write back to the SDK', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc, storage } = setup();
    const write = new Subject<void>();
    vi.mocked(storage.updateTokens).mockReturnValue(write);
    await firstValueFrom(svc.init(OIDC_SESSION));
    const opts = vi.mocked(createClient).mock.calls[0][0];

    const pending = opts.onTokenRefresh?.({
      accessToken: 'a2',
      refreshToken: 'r2',
      expiry: new Date(5_000),
    }) as unknown;

    expect(storage.updateTokens).toHaveBeenCalledWith(
      '@me:hs',
      'a2',
      'r2',
      5_000,
    );
    // The SDK awaits this before adopting the new pair; a bare void would let it run on
    // tokens that never reached storage.
    expect(pending).toBeInstanceOf(Promise);
    let settled = false;
    void (pending as Promise<void>).then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    write.next();
    write.complete();
    await expect(pending).resolves.toBeUndefined();
  });

  describe('signOutAll', () => {
    it('logs out every live client', async () => {
      const a = fakeClient();
      const b = fakeClient('https://other.example');
      const logoutA = vi.fn().mockResolvedValue(undefined);
      const logoutB = vi.fn().mockResolvedValue(undefined);
      (a as unknown as { logout: unknown }).logout = logoutA;
      (b as unknown as { logout: unknown }).logout = logoutB;
      vi.mocked(createClient).mockReturnValueOnce(a as never);
      vi.mocked(createClient).mockReturnValueOnce(b as never);
      const { svc } = setup();
      await firstValueFrom(svc.init(SESSION));
      await firstValueFrom(svc.add(SESSION_B));

      await firstValueFrom(svc.signOutAll());

      // `true` = stop the client from re-authenticating; the device is being discarded.
      expect(logoutA).toHaveBeenCalledWith(true);
      expect(logoutB).toHaveBeenCalledWith(true);
    });

    it('signs nothing out once the clients have been torn down', async () => {
      // The ordering trap this method carries: it reads the live-client registry, and
      // `stop()` empties it. Calling this after a teardown is a silent no-op that looks
      // identical from the outside — a caller that sequences them the wrong way round
      // ships a sign-out phase that never sends a request.
      const client = fakeClient();
      const logout = vi.fn().mockResolvedValue(undefined);
      (client as unknown as { logout: unknown }).logout = logout;
      vi.mocked(createClient).mockReturnValue(client as never);
      const { svc } = setup();
      await firstValueFrom(svc.init(SESSION));
      await firstValueFrom(svc.stop());

      await firstValueFrom(svc.signOutAll());

      expect(logout).not.toHaveBeenCalled();
    });

    it('resolves even when a homeserver refuses the logout', async () => {
      const client = fakeClient();
      (client as unknown as { logout: unknown }).logout = vi
        .fn()
        .mockRejectedValue(new Error('homeserver down'));
      vi.mocked(createClient).mockReturnValue(client as never);
      const { svc } = setup();
      await firstValueFrom(svc.init(SESSION));

      await expect(firstValueFrom(svc.signOutAll())).resolves.toBeUndefined();
    });
  });

  it('passes no OAuth token wiring for a password or SSO session', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();

    await firstValueFrom(svc.init(SESSION));

    const opts = vi.mocked(createClient).mock.calls[0][0];
    expect(opts.refreshToken).toBeUndefined();
    expect(opts.oauthClientId).toBeUndefined();
    expect(opts.onTokenRefresh).toBeUndefined();
  });

  it('does not publish the client until startClient resolves', async () => {
    const client = fakeClient();
    client.startClient.mockRejectedValue(new Error('sync failed'));
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();

    await expect(firstValueFrom(svc.init(SESSION))).rejects.toThrow(
      'sync failed',
    );
    // Rolled back: client stopped, 4S key cleared, nothing left half-initialized.
    expect(client.stopClient).toHaveBeenCalled();
    expect(clearHolder).toHaveBeenCalled();
    expect(svc.isInitialized).toBe(false);
  });

  it('does not report an Account ready before its projection barrier acknowledges', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc, projections } = setup();
    const barrier = new Subject<ProjectionReadiness>();
    const waitFor = vi.spyOn(projections, 'waitFor').mockReturnValue(barrier);

    let settled = false;
    const start = firstValueFrom(
      svc.restorePersisted(SESSION, 'background'),
    ).then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.waitFor(() => expect(waitFor).toHaveBeenCalledOnce());
    expect(waitFor).toHaveBeenCalledWith({
      kind: 'exact-account',
      accountId: '@me:hs',
    });
    expect(settled).toBe(false);

    barrier.next({
      scope: { kind: 'exact-account', accountId: '@me:hs' },
      durationMs: 1,
      projectionCount: 1,
      listenerCount: 1,
      retainedBytes: 0,
      acknowledgements: [{ projectionId: 'matrix.sync-state', generation: 1 }],
    });
    barrier.complete();

    await expect(start).resolves.toEqual({ kind: 'ready' });
  });

  it('tears down a prior client when re-initialized', async () => {
    const a = fakeClient();
    const b = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a as never)
      .mockReturnValueOnce(b as never);
    const { svc } = setup();

    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.init(SESSION));

    expect(a.stopClient).toHaveBeenCalled(); // old client torn down
    expect(svc.instance).toBe(b);
  });

  it('activates a fully started Account and can retire the other live runtimes', async () => {
    const a = fakeClient();
    const b = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a as never)
      .mockReturnValueOnce(b as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.add(SESSION_B));

    svc.activateAccount('@me:hs', 'replace');

    expect(svc.activeUserId()).toBe('@me:hs');
    expect(svc.accountIds()).toEqual(['@me:hs']);
    expect(b.stopClient).toHaveBeenCalled();
    expect(a.stopClient).not.toHaveBeenCalled();
  });

  it('rejects Active placement for an Account that is not live', () => {
    const { svc } = setup();

    expect(() => svc.activateAccount('@missing:hs', 'keep')).toThrow(
      /not live/i,
    );
  });

  it('rolls back a background Account start without wiping its stores', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();
    await firstValueFrom(svc.restorePersisted(SESSION, 'background'));

    await firstValueFrom(svc.rollbackAccountStart('@me:hs'));

    expect(svc.accountIds()).toEqual([]);
    expect(client.stopClient).toHaveBeenCalled();
    expect(client.clearStores).not.toHaveBeenCalled();
  });

  it('bridges sync state into the signal', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));

    // Grab the ClientEvent.Sync handler the service registered and fire it.
    const syncCall = client.on.mock.calls.find(([evt]) => evt === 'sync');
    expect(syncCall).toBeTruthy();
    syncCall![1]('SYNCING');
    await Promise.resolve();
    expect(svc.syncState()).toBe('SYNCING');
  });

  it('stop() tears down without clearing the stores', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));

    await firstValueFrom(svc.stop());

    expect(client.stopClient).toHaveBeenCalled();
    expect(client.clearStores).not.toHaveBeenCalled();
    expect(svc.isInitialized).toBe(false);
  });

  it('reset() stops the client and wipes the stores + 4S key', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));
    clearHolder.mockClear();

    await firstValueFrom(svc.reset());

    expect(client.stopClient).toHaveBeenCalled();
    expect(client.clearStores).toHaveBeenCalledOnce();
    expect(clearHolder).toHaveBeenCalled();
    expect(svc.isInitialized).toBe(false);
  });

  it("wipes the account's OWN Rust crypto store (its cryptoDatabasePrefix), not the SDK default", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();
    await firstValueFrom(
      svc.init({ ...SESSION, cryptoPrefix: 'trinity-crypto:@me:hs' }),
    );

    await firstValueFrom(svc.reset());

    // clearStores() must target THIS account's per-account prefix. Called with no
    // args, the SDK deletes only the default-prefix Rust crypto DB and orphans this
    // account's real store — so a later fresh login (new device id, same
    // userId-derived prefix) reopens a store whose device id mismatches the new one,
    // and initRustCrypto throws "the account in the store doesn't match the account
    // in the constructor".
    expect(client.clearStores).toHaveBeenCalledWith({
      cryptoDatabasePrefix: 'trinity-crypto:@me:hs',
    });
  });

  it('wipes with an undefined prefix for a migrated legacy account (SDK default store)', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION)); // no cryptoPrefix → SDK default store

    await firstValueFrom(svc.reset());

    // A legacy account really lives on the default prefix, so wiping must pass it
    // through unchanged (the SDK falls back to its default) — not invent a prefix.
    expect(client.clearStores).toHaveBeenCalledWith({
      cryptoDatabasePrefix: undefined,
    });
  });

  /** Grab the HttpApiEvent.SessionLoggedOut handler the service registered. */
  function loggedOutHandler(client: ReturnType<typeof fakeClient>) {
    return client.on.mock.calls.find(
      ([evt]) => evt === HttpApiEvent.SessionLoggedOut,
    )?.[1] as (err: unknown) => void;
  }

  it('soft-logout stops the account without wiping and marks it for re-auth', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc, storage } = setup();
    vi.mocked(storage.invalidateToken).mockReturnValue(of(undefined));
    await firstValueFrom(svc.init(SESSION));

    loggedOutHandler(client)({ data: { soft_logout: true } });

    expect(client.stopClient).toHaveBeenCalled();
    expect(client.clearStores).not.toHaveBeenCalled(); // stores preserved for re-auth
    expect(storage.remove).not.toHaveBeenCalled(); // registry entry preserved
    expect(storage.invalidateToken).toHaveBeenCalledWith('@me:hs'); // dead token dropped
    expect(svc.softLoggedOut()).toContain('@me:hs');
    expect(svc.isInitialized).toBe(false); // it was the only account
  });

  it('soft-logout of the active account repoints active + storage to a survivor', async () => {
    const a = fakeClient();
    const b = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a as never)
      .mockReturnValueOnce(b as never);
    const { svc, storage } = setup();
    vi.mocked(storage.invalidateToken).mockReturnValue(of(undefined));
    vi.mocked(storage.setActive).mockReturnValue(of(undefined));
    await firstValueFrom(svc.init(SESSION)); // A active
    await firstValueFrom(svc.add(SESSION_B)); // B added, now active

    loggedOutHandler(b)({ data: { soft_logout: true } });

    expect(svc.activeUserId()).toBe('@me:hs'); // A survives and becomes active
    expect(svc.softLoggedOut()).toContain('@you:other');
    expect(storage.setActive).toHaveBeenCalledWith('@me:hs'); // persisted active reconciled
    expect(svc.isInitialized).toBe(true);
  });

  it('hard-logout wipes the account and drops its registry entry', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc, storage } = setup();
    vi.mocked(storage.remove).mockReturnValue(of(undefined));
    await firstValueFrom(svc.init(SESSION));

    loggedOutHandler(client)({ data: { soft_logout: false } });

    expect(client.stopClient).toHaveBeenCalled();
    expect(client.clearStores).toHaveBeenCalledOnce(); // wiped
    expect(storage.remove).toHaveBeenCalledWith('@me:hs');
    expect(svc.softLoggedOut()).not.toContain('@me:hs');
  });

  it('re-authenticating a soft-logged-out account clears the flag', async () => {
    const a = fakeClient();
    const b = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a as never)
      .mockReturnValueOnce(b as never);
    const { svc, storage } = setup();
    vi.mocked(storage.invalidateToken).mockReturnValue(of(undefined));
    await firstValueFrom(svc.init(SESSION));

    loggedOutHandler(a)({ data: { soft_logout: true } });
    expect(svc.softLoggedOut()).toContain('@me:hs');

    // Re-auth = the same account logging back in (its store + registry survived).
    await firstValueFrom(svc.init(SESSION));

    expect(svc.softLoggedOut()).not.toContain('@me:hs');
    expect(svc.isInitialized).toBe(true);
  });

  it('maps sync state to connectivity (offline while erroring/reconnecting)', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));

    // Before any sync transition the app reads online (no startup offline flash).
    expect(svc.connectivity()).toBe('online');

    // Drive the Sync listener the service registered during init().
    const onSync = client.on.mock.calls.find(
      (c: unknown[]) => c[0] === ClientEvent.Sync,
    )?.[1] as (state: SyncState) => void;

    onSync(SyncState.Error);
    await Promise.resolve();
    expect(svc.connectivity()).toBe('offline');
    onSync(SyncState.Reconnecting);
    await Promise.resolve();
    expect(svc.connectivity()).toBe('offline');
    onSync(SyncState.Syncing);
    await Promise.resolve();
    expect(svc.connectivity()).toBe('online');
  });

  it('logs in even when the sync-store startup fails (cache is best-effort)', async () => {
    vi.stubGlobal('indexedDB', {}); // present → an IndexedDBStore is built
    storeMock.startup.mockRejectedValue(new Error('IndexedDB corrupt'));
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();

    await expect(firstValueFrom(svc.init(SESSION))).resolves.toBeUndefined();
    expect(svc.isInitialized).toBe(true); // a broken cache must not block login
    expect(client.startClient).toHaveBeenCalledOnce();
  });

  it('closes the sync store on teardown (no leaked IndexedDB connection)', async () => {
    vi.stubGlobal('indexedDB', {});
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));

    await firstValueFrom(svc.stop());
    await Promise.resolve(); // let the best-effort destroy() microtask run

    expect(storeMock.destroy).toHaveBeenCalled();
  });

  // --- multi-account registry -----------------------------------------------

  /** The account's registered ClientEvent.Sync listener. */
  const syncOf = (client: ReturnType<typeof fakeClient>) =>
    client.on.mock.calls.find(
      (c: unknown[]) => c[0] === ClientEvent.Sync,
    )?.[1] as (s: SyncState) => void;

  it('add() keeps existing accounts running and activates the new one', async () => {
    const a = fakeClient();
    const b = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a as never)
      .mockReturnValueOnce(b as never);
    const { svc } = setup();

    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.add(SESSION_B));

    expect(a.stopClient).not.toHaveBeenCalled(); // first account kept running
    expect(svc.instance).toBe(b); // new account active
    expect(svc.activeUserId()).toBe('@you:other');
    expect([...svc.accountIds()].sort()).toEqual(['@me:hs', '@you:other']);
    expect(svc.all().length).toBe(2);
  });

  it('measures projection listeners and retained payload per live Account', async () => {
    const a = fakeClient();
    const b = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a as never)
      .mockReturnValueOnce(b as never);
    const { svc, projections } = setup();

    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.add(SESSION_B));
    expect(projections.diagnostics()).toMatchObject({
      activeProjections: 2,
      listenerCount:
        2 * MATRIX_SYNC_PROJECTION_BASELINE.listenerCountPerLiveAccount,
      retainedBytes: 0,
    });

    const publishSync = syncOf(a);
    publishSync(SyncState.Reconnecting);
    await Promise.resolve();
    publishSync(SyncState.Prepared);
    expect(projections.diagnostics().retainedBytes).toBe(
      MATRIX_SYNC_PROJECTION_BASELINE.maxRetainedBytesPerLiveAccount,
    );
    await Promise.resolve();

    for (const state of Object.values(SyncState)) {
      publishSync(state);
      await Promise.resolve();
      expect(projections.diagnostics().retainedBytes).toBeLessThanOrEqual(
        MATRIX_SYNC_PROJECTION_BASELINE.maxRetainedBytesPerLiveAccount,
      );
    }

    await firstValueFrom(svc.stop());
    expect(projections.diagnostics()).toMatchObject({
      activeProjections: 0,
      listenerCount: 0,
      retainedBytes: 0,
    });
  });

  it('setActive() switches which client instance returns (no-op if unknown)', async () => {
    const a = fakeClient();
    const b = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a as never)
      .mockReturnValueOnce(b as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.add(SESSION_B)); // B active

    svc.setActive('@me:hs');
    expect(svc.instance).toBe(a);
    expect(svc.activeUserId()).toBe('@me:hs');

    svc.setActive('@nobody:hs'); // unknown → no change
    expect(svc.activeUserId()).toBe('@me:hs');
  });

  it('remove() signs one account out (wipes its stores); others survive', async () => {
    const a = fakeClient();
    const b = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a as never)
      .mockReturnValueOnce(b as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.add(SESSION_B)); // B active

    await firstValueFrom(svc.remove('@you:other'));

    expect(b.stopClient).toHaveBeenCalled();
    expect(b.clearStores).toHaveBeenCalledOnce(); // its stores wiped
    expect(a.clearStores).not.toHaveBeenCalled(); // the other account untouched
    expect(svc.instance).toBe(a); // active repointed to the survivor
    expect([...svc.accountIds()]).toEqual(['@me:hs']);
  });

  it('add() for an already-signed-in account replaces its client (no leak)', async () => {
    const a1 = fakeClient();
    const a2 = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a1 as never)
      .mockReturnValueOnce(a2 as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION)); // A via a1
    await firstValueFrom(svc.add(SESSION)); // re-add the same account via a2

    expect(a1.stopClient).toHaveBeenCalled(); // old client torn down, not orphaned
    expect(a1.off).toHaveBeenCalled(); // its Sync listener detached
    expect(svc.instance).toBe(a2);
    expect([...svc.accountIds()]).toEqual(['@me:hs']); // still a single account
    expect(svc.all().length).toBe(1);
  });

  it('re-adds an account after signing it out (awaits its store wipe)', async () => {
    const a1 = fakeClient();
    const a2 = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a1 as never)
      .mockReturnValueOnce(a2 as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.reset()); // sign out (background store wipe)
    await firstValueFrom(svc.add(SESSION)); // sign back in

    expect(a1.clearStores).toHaveBeenCalled(); // its stores were wiped
    expect(svc.instance).toBe(a2);
    expect(svc.isInitialized).toBe(true);
  });

  it('clientFor() returns the account client, or null', async () => {
    const a = fakeClient();
    vi.mocked(createClient).mockReturnValue(a as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));

    expect(svc.clientFor('@me:hs')).toBe(a);
    expect(svc.clientFor('@nobody:hs')).toBeNull();
  });

  describe('persisted Account startup outcomes', () => {
    it('serializes the SDK crypto migration critical section across Accounts', async () => {
      const firstClient = fakeClient();
      const secondClient = fakeClient();
      let finishFirst!: () => void;
      firstClient.initRustCrypto.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          }),
      );
      vi.mocked(createClient)
        .mockReturnValueOnce(firstClient as never)
        .mockReturnValueOnce(secondClient as never);
      const { svc } = setup();

      const first = firstValueFrom(svc.restorePersisted(SESSION, 'activate'));
      await vi.waitFor(() =>
        expect(firstClient.initRustCrypto).toHaveBeenCalledOnce(),
      );
      const second = firstValueFrom(
        svc.restorePersisted(SESSION_B, 'background'),
      );

      await Promise.resolve();
      expect(secondClient.initRustCrypto).not.toHaveBeenCalled();
      finishFirst();
      await vi.waitFor(() =>
        expect(secondClient.initRustCrypto).toHaveBeenCalledOnce(),
      );
      await expect(Promise.all([first, second])).resolves.toEqual([
        { kind: 'ready' },
        { kind: 'ready' },
      ]);
    });

    it('continues the crypto initialization queue after an Account fails', async () => {
      const firstClient = fakeClient();
      const secondClient = fakeClient();
      let failFirst!: (error: Error) => void;
      firstClient.initRustCrypto.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            failFirst = reject;
          }),
      );
      vi.mocked(createClient)
        .mockReturnValueOnce(firstClient as never)
        .mockReturnValueOnce(secondClient as never);
      const { svc } = setup();

      const first = firstValueFrom(svc.restorePersisted(SESSION, 'activate'));
      await vi.waitFor(() =>
        expect(firstClient.initRustCrypto).toHaveBeenCalledOnce(),
      );
      const second = firstValueFrom(
        svc.restorePersisted(SESSION_B, 'background'),
      );

      expect(secondClient.initRustCrypto).not.toHaveBeenCalled();
      failFirst(new Error('first Account failed'));

      await expect(first).resolves.toEqual({
        kind: 'failed',
        failure: 'crypto-failure',
      });
      await vi.waitFor(() =>
        expect(secondClient.initRustCrypto).toHaveBeenCalledOnce(),
      );
      await expect(second).resolves.toEqual({ kind: 'ready' });
    });

    it('activates a restored Account only after startup commits', async () => {
      const client = fakeClient();
      vi.mocked(createClient).mockReturnValue(client as never);
      const { svc } = setup();

      const outcome = await firstValueFrom(
        svc.restorePersisted(SESSION, 'activate'),
      );

      expect(outcome).toEqual({ kind: 'ready' });
      expect(svc.activeUserId()).toBe('@me:hs');
    });

    it('classifies crypto bootstrap failures without exposing their details', async () => {
      const client = fakeClient();
      client.initRustCrypto.mockRejectedValue(
        new Error('secret-bearing crypto detail'),
      );
      vi.mocked(createClient).mockReturnValue(client as never);
      const { svc } = setup();

      const outcome = await firstValueFrom(
        svc.restorePersisted(SESSION, 'activate'),
      );

      expect(outcome).toEqual({
        kind: 'failed',
        failure: 'crypto-failure',
      });
      expect(JSON.stringify(outcome)).not.toContain('secret-bearing');
      expect(svc.activeUserId()).toBeNull();
    });

    it.each([
      [
        { errcode: 'M_UNKNOWN_TOKEN', httpStatus: 401 },
        'reauthentication-required',
      ],
      [new ConnectionError('offline'), 'transient-network'],
      [
        Object.assign(new Error('refresh failed'), {
          name: 'TokenRefreshError',
        }),
        'transient-network',
      ],
      [{ httpStatus: 503 }, 'transient-network'],
      [{ name: 'TimeoutError' }, 'transient-network'],
    ] as const)(
      'classifies an expected start failure',
      async (error, failure) => {
        const client = fakeClient();
        client.startClient.mockRejectedValue(error);
        vi.mocked(createClient).mockReturnValue(client as never);
        const { svc } = setup();

        await expect(
          firstValueFrom(svc.restorePersisted(SESSION, 'activate')),
        ).resolves.toEqual({ kind: 'failed', failure });
        expect(svc.activeUserId()).toBeNull();
        expect(svc.softLoggedOut().includes(SESSION.userId)).toBe(
          failure === 'reauthentication-required',
        );
      },
    );

    it('keeps unexpected adapter failures on the Observable error channel', async () => {
      const client = fakeClient();
      client.startClient.mockRejectedValue(new Error('adapter defect'));
      vi.mocked(createClient).mockReturnValue(client as never);
      const { svc } = setup();

      await expect(
        firstValueFrom(svc.restorePersisted(SESSION, 'activate')),
      ).rejects.toThrow('adapter defect');
    });
  });

  it('syncState/connectivity follow the active account across a switch', async () => {
    const a = fakeClient();
    const b = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a as never)
      .mockReturnValueOnce(b as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.add(SESSION_B)); // B active

    syncOf(a)(SyncState.Syncing);
    syncOf(b)(SyncState.Error);
    await Promise.resolve();
    expect(svc.connectivity()).toBe('offline'); // active B is erroring

    svc.setActive('@me:hs');
    expect(svc.connectivity()).toBe('online'); // active A is syncing
  });

  // --- per-account crypto isolation -----------------------------------------

  it('wires each account its own 4S holder and follows the active account', async () => {
    const a = fakeClient();
    const b = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a as never)
      .mockReturnValueOnce(b as never);
    const { svc } = setup();

    expect(svc.activeHolder()).toBeNull(); // nothing signed in yet

    await firstValueFrom(svc.init(SESSION)); // A
    await firstValueFrom(svc.add(SESSION_B)); // B, now active

    // Each client got its OWN cryptoCallbacks, so a background account's key op
    // cannot read or overwrite another account's key.
    const callA = vi.mocked(createClient).mock.calls[0][0];
    const callB = vi.mocked(createClient).mock.calls[1][0];
    expect(callA.cryptoCallbacks?.getSecretStorageKey).not.toBe(
      callB.cryptoCallbacks?.getSecretStorageKey,
    );

    // activeHolder() follows the active account: B's holder while B is active...
    const holderB = svc.activeHolder();
    expect(holderB).not.toBeNull();
    expect(holderB!.getSecretStorageKey).toBe(
      callB.cryptoCallbacks?.getSecretStorageKey,
    );

    // ...and A's DISTINCT holder after switching back to A.
    svc.setActive('@me:hs');
    const holderA = svc.activeHolder();
    expect(holderA!.getSecretStorageKey).toBe(
      callA.cryptoCallbacks?.getSecretStorageKey,
    );
    expect(holderA).not.toBe(holderB);
  });

  it('serializes a same-account re-add behind its still-pending store wipe', async () => {
    const a1 = fakeClient();
    const a2 = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a1 as never)
      .mockReturnValueOnce(a2 as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));
    expect(createClient).toHaveBeenCalledOnce();

    // Its store wipe never settles yet, so reset()'s background delete stays pending.
    let resolveWipe!: () => void;
    a1.clearStores.mockReturnValue(
      new Promise<void>((resolve) => (resolveWipe = resolve)),
    );
    await firstValueFrom(svc.reset()); // sign out — wipe tracked, still pending

    // Re-add the same account: start() must await the pending wipe before opening a
    // second connection to the same per-account store.
    const readded = firstValueFrom(svc.add(SESSION));
    await new Promise((resolve) => setTimeout(resolve, 0)); // drain microtasks
    expect(createClient).toHaveBeenCalledOnce(); // still 1 — blocked on the wipe

    resolveWipe();
    await readded;
    expect(createClient).toHaveBeenCalledTimes(2); // re-add proceeded after the wipe
    expect(svc.instance).toBe(a2);
    expect(svc.isInitialized).toBe(true);
  });

  it('re-binds syncState to the fresh signal when the active account is re-added', async () => {
    const a1 = fakeClient();
    const a2 = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a1 as never)
      .mockReturnValueOnce(a2 as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));

    syncOf(a1)(SyncState.Syncing);
    await Promise.resolve();
    expect(svc.syncState()).toBe('SYNCING');

    // Re-add the SAME active account: fresh client + fresh per-account syncState
    // signal, active id net-unchanged.
    await firstValueFrom(svc.add(SESSION));
    expect(svc.syncState()).toBeNull(); // re-bound to a2's untransitioned signal

    syncOf(a2)(SyncState.Error); // only the NEW client's listener now feeds state
    await Promise.resolve();
    expect(svc.connectivity()).toBe('offline');
  });

  it('ignores a duplicate server logout for an already-removed account', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc, storage } = setup();
    await firstValueFrom(svc.init(SESSION));
    const onLoggedOut = loggedOutHandler(client);

    await firstValueFrom(svc.remove('@me:hs')); // detaches listener, wipes once, drops entry
    expect(client.clearStores).toHaveBeenCalledOnce();
    expect(svc.activeUserId()).toBeNull();

    // A late / duplicate server-side logout for the same, now-gone account.
    expect(() => onLoggedOut({ data: { soft_logout: false } })).not.toThrow();

    expect(client.clearStores).toHaveBeenCalledOnce(); // not wiped a second time
    expect(storage.remove).not.toHaveBeenCalled(); // registry untouched
    expect(storage.invalidateToken).not.toHaveBeenCalled();
    expect(svc.activeUserId()).toBeNull();
  });

  describe('wiping an account that has no live client', () => {
    // L2. remove() is documented as "stop it + wipe its stores", and the account with
    // nothing to stop — soft-logged-out, or a failed background warm-up — is exactly the
    // one whose crypto store would be orphaned: logout deletes the registry record that
    // carries its cryptoPrefix moments later, and then nothing can name the store.

    /** A minimal IDBFactory that records deletes and reports each as a success. */
    function fakeIndexedDb(deleted: string[]) {
      return {
        deleteDatabase(name: string) {
          deleted.push(name);
          const request: { onsuccess: (() => void) | null } = {
            onsuccess: null,
          };
          setTimeout(() => request.onsuccess?.(), 0);
          return request as unknown as IDBOpenDBRequest;
        },
      };
    }

    it('deletes its databases by name, from the registry record', async () => {
      const deleted: string[] = [];
      vi.stubGlobal('indexedDB', fakeIndexedDb(deleted));
      const { svc, storage } = setup();
      vi.mocked(storage.record).mockReturnValue(
        of({
          userId: '@ghost:hs',
          baseUrl: 'https://hs.example',
          deviceId: 'DEV',
          cryptoPrefix: 'trinity-crypto:@ghost:hs',
        }),
      );

      await firstValueFrom(svc.remove('@ghost:hs')); // never started a client
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect([...deleted].sort()).toEqual([
        'matrix-js-sdk:trinity-sync:@ghost:hs',
        'trinity-crypto:@ghost:hs::matrix-sdk-crypto',
        'trinity-crypto:@ghost:hs::matrix-sdk-crypto-meta',
      ]);
    });

    it('leaves the SDK-default crypto pair alone when no record names it', async () => {
      // Without a record the prefix is unknown, and the default pair may belong to a
      // migrated legacy account — the cold-start orphan sweep owns that case.
      const deleted: string[] = [];
      vi.stubGlobal('indexedDB', fakeIndexedDb(deleted));
      const { svc } = setup(); // record() defaults to null

      await firstValueFrom(svc.remove('@ghost:hs'));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(deleted).toEqual(['matrix-js-sdk:trinity-sync:@ghost:hs']);
    });
  });

  describe('a start whose caller does not survive it', () => {
    // H1. The callers are route guards, and the Router unsubscribes a guard whose
    // navigation is superseded — mid-chain, i.e. somewhere inside open-IndexedDB → WASM →
    // initRustCrypto → startClient. What must never follow is a SECOND client for the same
    // account: two initRustCrypto calls open one device's crypto store twice.

    /** A client whose crypto bootstrap hangs until the returned resolver is called. */
    function clientWithPendingCrypto() {
      const client = fakeClient();
      let release!: () => void;
      client.initRustCrypto.mockReturnValue(
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
      );
      return { client, release: () => release() };
    }

    /** Let the (now unblocked) chain run to its end. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('rolls the client back when it is unsubscribed mid-initRustCrypto', async () => {
      const { client, release } = clientWithPendingCrypto();
      vi.mocked(createClient).mockReturnValue(client as never);
      const { svc } = setup();

      svc.init(SESSION).subscribe().unsubscribe(); // navigation superseded
      release();
      await settle();

      // It runs to completion (a promise cannot be cancelled), then undoes itself —
      // rather than syncing on unreachable with its crypto store open.
      expect(client.stopClient).toHaveBeenCalled();
      expect(client.off).toHaveBeenCalledWith(
        ClientEvent.Sync,
        expect.any(Function),
      );
      expect(clearHolder).toHaveBeenCalled();
      expect(svc.isInitialized).toBe(false);
      expect([...svc.accountIds()]).toEqual([]);
    });

    it('joins an in-flight start instead of building a second client', async () => {
      // The reachable shape: a deep link completes login for the SAME account while the
      // initial guard is still inside initRustCrypto.
      const { client, release } = clientWithPendingCrypto();
      vi.mocked(createClient).mockReturnValue(client as never);
      const { svc } = setup();

      const guard = firstValueFrom(svc.init(SESSION));
      const deepLink = firstValueFrom(svc.add(SESSION));
      release();
      await Promise.all([guard, deepLink]);

      expect(createClient).toHaveBeenCalledOnce();
      expect(client.initRustCrypto).toHaveBeenCalledOnce();
      expect([...svc.accountIds()]).toEqual(['@me:hs']);
      expect(svc.instance).toBe(client);
      expect(client.stopClient).not.toHaveBeenCalled(); // both callers wanted it
    });

    it('does not replay a FAILED start to the next caller', async () => {
      // The in-flight entry is dropped the moment the chain settles, so the login after a
      // failure gets a real attempt rather than the cached rejection.
      const failing = fakeClient();
      failing.startClient.mockRejectedValue(new Error('sync boom'));
      const working = fakeClient();
      vi.mocked(createClient)
        .mockReturnValueOnce(failing as never)
        .mockReturnValueOnce(working as never);
      const { svc } = setup();

      await expect(firstValueFrom(svc.init(SESSION))).rejects.toThrow(
        'sync boom',
      );
      expect(failing.stopClient).toHaveBeenCalled();

      await firstValueFrom(svc.init(SESSION));

      expect(createClient).toHaveBeenCalledTimes(2);
      expect(svc.instance).toBe(working);
    });
  });

  describe('CORS origin publishing (desktop)', () => {
    // On desktop the renderer must publish the live homeserver origin set so main's CORS
    // shim can be scoped to it (electron/src/cors.ts). Published on every account-set
    // change; the whole set is REPLACED each time so a signed-out account is revoked.
    it('publishes the live homeserver origins whenever the account set changes', async () => {
      const setAllowedOrigins = vi.fn();
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
        desktopBridgeFixture({
          capabilities: {
            networkCors: { setAllowedOrigins, allowOrigin: vi.fn() },
          },
        });
      try {
        vi.mocked(createClient).mockReturnValueOnce(
          fakeClient('https://hs.example') as never,
        );
        const { svc, storage } = setup();
        vi.mocked(storage.save).mockReturnValue(of(SESSION));
        vi.mocked(storage.setActive).mockReturnValue(of(undefined));

        await firstValueFrom(svc.init(SESSION));
        expect(setAllowedOrigins).toHaveBeenLastCalledWith([
          'https://hs.example',
        ]);

        // A second account joins → the set now carries both origins.
        vi.mocked(createClient).mockReturnValueOnce(
          fakeClient('https://other.example') as never,
        );
        vi.mocked(storage.save).mockReturnValue(of(SESSION_B));
        await firstValueFrom(svc.add(SESSION_B));
        expect(setAllowedOrigins).toHaveBeenLastCalledWith([
          'https://hs.example',
          'https://other.example',
        ]);
      } finally {
        delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
      }
    });

    it('declares the homeserver origin BEFORE the client that calls it is built', async () => {
      // M4. startClient() issues /versions, the thread-support probe and the first /sync
      // before it resolves, so a set published only afterwards leaves all three to be
      // blocked against a homeserver whose proxy strips CORS headers — and a failed
      // getVersions() disables server-side threads for the whole session.
      const order: string[] = [];
      const allowOrigin = vi.fn(() => order.push('allowOrigin'));
      const setAllowedOrigins = vi.fn(() => order.push('setAllowedOrigins'));
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
        desktopBridgeFixture({
          capabilities: { networkCors: { setAllowedOrigins, allowOrigin } },
        });
      try {
        const client = fakeClient();
        client.startClient.mockImplementation(() => {
          order.push('startClient');
          return Promise.resolve();
        });
        vi.mocked(createClient).mockImplementation((() => {
          order.push('createClient');
          return client;
        }) as never);
        const { svc } = setup();

        await firstValueFrom(svc.add(SESSION));

        expect(allowOrigin).toHaveBeenCalledWith('https://hs.example');
        expect(order).toEqual([
          'allowOrigin',
          'createClient',
          'startClient',
          // The post-registration publish still runs, so a removal keeps applying.
          'setAllowedOrigins',
        ]);
      } finally {
        delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
      }
    });

    it('does not throw off desktop (no bridge)', async () => {
      delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
      vi.mocked(createClient).mockReturnValueOnce(fakeClient() as never);
      const { svc } = setup();

      await expect(firstValueFrom(svc.init(SESSION))).resolves.not.toThrow();
      expect(svc.isInitialized).toBe(true);
    });
  });
});

describe('OAuth tokens through a real MatrixClient', () => {
  // Only the network is fake. The client, its TokenManager, discovery and the OAuth2
  // refresh grant are matrix-js-sdk 43's own, built from the options start() passes.
  const OP = 'https://op.example';
  const METADATA = {
    issuer: `${OP}/`,
    authorization_endpoint: `${OP}/authorize`,
    token_endpoint: `${OP}/token`,
    revocation_endpoint: `${OP}/revoke`,
    registration_endpoint: `${OP}/register`,
    response_modes_supported: ['query', 'fragment'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
  };

  /** How the fake provider answers a refresh grant. */
  type Rotation = 'rotate' | 'omit' | 'empty';

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  /** A homeserver that accepts only the tokens the fake provider issued, and that provider. */
  function fakeNetwork(rotation: Rotation = 'rotate') {
    const live = new Set<string>();
    const grants: URLSearchParams[] = [];
    const revocations: string[] = [];
    const calls: string[] = [];
    const state = {
      discovery: 'up' as 'up' | 'down',
      provider: 'up' as 'up' | 'down' | 503,
    };
    let issued = 1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        const form = new URLSearchParams(String(init.body ?? ''));
        calls.push(`${init.method ?? 'GET'} ${url.host}${url.pathname}`);
        if (url.pathname === '/_matrix/client/v1/auth_metadata') {
          if (state.discovery === 'down')
            throw new TypeError('Failed to fetch');
          return json(METADATA);
        }
        if (url.href === METADATA.token_endpoint) {
          if (state.provider === 'down') throw new TypeError('Failed to fetch');
          if (state.provider === 503) {
            return json({ error: 'temporarily_unavailable' }, 503);
          }
          grants.push(form);
          issued += 1;
          live.add(`at-${issued}`);
          return json({
            token_type: 'Bearer',
            access_token: `at-${issued}`,
            // Under the SDK's 60 s window, so a later 401 reads as expiry, not revocation.
            expires_in: 30,
            ...(rotation === 'rotate'
              ? { refresh_token: `rt-${issued}` }
              : rotation === 'empty'
                ? { refresh_token: '' }
                : {}),
          });
        }
        if (url.href === METADATA.revocation_endpoint) {
          revocations.push(form.get('token_type_hint') ?? '');
          return new Response('', { status: 200 });
        }
        if (url.pathname === '/_matrix/client/v3/account/whoami') {
          const bearer = new Headers(init.headers).get('authorization') ?? '';
          return live.has(bearer.replace(/^Bearer /, ''))
            ? json({ user_id: '@me:hs', device_id: 'DEV' })
            : json(
                {
                  errcode: 'M_UNKNOWN_TOKEN',
                  error: 'expired',
                  soft_logout: false,
                },
                401,
              );
        }
        if (url.pathname.endsWith('/logout')) return json({});
        throw new Error(`unexpected ${init.method ?? 'GET'} ${url.href}`);
      }),
    );
    return {
      live,
      grants,
      revocations,
      calls,
      state,
      expireAll: () => live.clear(),
    };
  }

  /** Let createClient build real clients; stub only crypto, sync and store deletion. */
  async function useRealClients(): Promise<void> {
    const actual =
      await vi.importActual<typeof import('matrix-js-sdk')>('matrix-js-sdk');
    vi.mocked(createClient).mockImplementation((opts) => {
      const client = actual.createClient(opts);
      vi.spyOn(client, 'initRustCrypto').mockResolvedValue(undefined);
      vi.spyOn(client, 'startClient').mockResolvedValue(undefined);
      vi.spyOn(client, 'clearStores').mockResolvedValue(undefined);
      return client;
    });
    // jsdom has no IndexedDB; say so, so the client runs on its in-memory store.
    vi.stubGlobal('indexedDB', undefined);
  }

  async function startReal() {
    await useRealClients();
    const ctx = setup();
    vi.mocked(ctx.storage.updateTokens).mockReturnValue(of(undefined));
    // If a refresh ever ends in a logout, let the logout path run to completion so the
    // assertions see its effect rather than a mock error.
    vi.mocked(ctx.storage.remove).mockReturnValue(of(undefined));
    vi.mocked(ctx.storage.invalidateToken).mockReturnValue(of(undefined));
    vi.mocked(ctx.storage.setActive).mockReturnValue(of(undefined));
    await firstValueFrom(ctx.svc.init(OIDC_SESSION));
    return { ...ctx, client: ctx.svc.instance };
  }

  /** Still signed in, nothing wiped: the hard-logout path deletes the sync and crypto stores. */
  function expectStillSignedIn(
    svc: MatrixClientService,
    client: MatrixClient,
    userId = OIDC_SESSION.userId,
  ): void {
    expect(svc.accountIds()).toContain(userId);
    expect(svc.softLoggedOut()).not.toContain(userId);
    expect(client.clearStores).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.mocked(createClient).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refreshes at each expiry and persists the rotated pair under its own account', async () => {
    const net = fakeNetwork('rotate');
    const { svc, storage, client } = await startReal();
    const before = Date.now();

    await expect(client.whoami()).resolves.toMatchObject({ user_id: '@me:hs' });

    // Discovery goes through the account's own homeserver, never the issuer.
    expect(net.calls).toContain(
      'GET hs.example/_matrix/client/v1/auth_metadata',
    );
    expect(net.grants[0].get('refresh_token')).toBe('refresh-tok');
    expect(net.grants[0].get('client_id')).toBe('client-1');
    const [userId, access, refresh, expiry] = vi.mocked(storage.updateTokens)
      .mock.calls[0];
    expect([userId, access, refresh]).toEqual(['@me:hs', 'at-2', 'rt-2']);
    expect(expiry).toBeGreaterThanOrEqual(before + 30_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 30_000);

    net.expireAll();
    await expect(client.whoami()).resolves.toBeDefined();
    expect(net.grants[1].get('refresh_token')).toBe('rt-2');
    expect(client.getAccessToken()).toBe('at-3');
    expectStillSignedIn(svc, client);
  });

  it('keeps the old pair in memory when the refreshed tokens cannot be persisted', async () => {
    const net = fakeNetwork('rotate');
    const { svc, storage, client } = await startReal();
    vi.mocked(storage.updateTokens).mockReturnValue(
      throwError(() => new Error('secure store locked')),
    );

    await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

    expect(client.getAccessToken()).toBe('tok');
    expect(client.getRefreshToken()).toBe('refresh-tok');
    expect(net.grants).toHaveLength(1);
    expect(storage.updateTokens).toHaveBeenCalledOnce();
    expectStillSignedIn(svc, client);
  });

  it('survives a refresh attempted while offline and recovers when the network returns', async () => {
    const net = fakeNetwork('rotate');
    const { svc, storage, client } = await startReal();

    net.state.discovery = 'down';
    await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);
    net.state.discovery = 'up';
    net.state.provider = 'down';
    await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);
    expect(storage.updateTokens).not.toHaveBeenCalled();
    expectStillSignedIn(svc, client);

    net.state.provider = 'up';
    await expect(client.whoami()).resolves.toBeDefined();
    expect(storage.updateTokens).toHaveBeenCalledOnce();
  });

  it('does not sign the account out when the provider answers 5xx', async () => {
    const net = fakeNetwork('rotate');
    const { svc, client } = await startReal();
    net.state.provider = 503;

    await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

    expect(net.calls).toContain('POST op.example/token');
    expectStillSignedIn(svc, client);
  });

  it('refreshes once for concurrent expired requests', async () => {
    const net = fakeNetwork('rotate');
    const { svc, client } = await startReal();

    await Promise.all([client.whoami(), client.whoami()]);

    expect(net.grants).toHaveLength(1);
    expect(
      net.calls.filter((call) => call.endsWith('/auth_metadata')),
    ).toHaveLength(1);
    expectStillSignedIn(svc, client);
  });

  it("persists each account's refreshed tokens under that account", async () => {
    const net = fakeNetwork('rotate');
    const { svc, storage } = await startReal();
    const other: MatrixSession = {
      ...OIDC_SESSION,
      baseUrl: 'https://other.example',
      userId: '@you:other',
      deviceId: 'DEV2',
      accessToken: 'tok2',
      refreshToken: 'refresh-tok2',
      oidc: { ...OIDC_SESSION.oidc, clientId: 'client-2' },
    };
    await firstValueFrom(svc.add(other));

    await Promise.all([
      svc.clientFor('@me:hs')!.whoami(),
      svc.clientFor('@you:other')!.whoami(),
    ]);

    for (const userId of ['@me:hs', '@you:other']) {
      const client = svc.clientFor(userId)!;
      expect(storage.updateTokens).toHaveBeenCalledWith(
        userId,
        client.getAccessToken(),
        client.getRefreshToken(),
        expect.any(Number),
      );
      expectStillSignedIn(svc, client, userId);
    }
    expect(net.grants.map((grant) => grant.get('client_id')).sort()).toEqual([
      'client-1',
      'client-2',
    ]);
  });

  it.each(['omit', 'empty'] as const)(
    'keeps the current refresh token when the provider does not rotate it (%s)',
    async (rotation) => {
      const net = fakeNetwork(rotation);
      const { svc, storage, client } = await startReal();

      await expect(client.whoami()).resolves.toBeDefined();
      expect(client.getRefreshToken()).toBe('refresh-tok');
      expect(storage.updateTokens).toHaveBeenLastCalledWith(
        '@me:hs',
        'at-2',
        'refresh-tok',
        expect.any(Number),
      );

      // The second expiry is where unpatched 43 finds no refresh token, logs out and wipes.
      net.expireAll();
      await expect(client.whoami()).resolves.toBeDefined();
      expect(net.grants[1].get('refresh_token')).toBe('refresh-tok');
      expectStillSignedIn(svc, client);
    },
  );

  it('revokes an OAuth session once at the provider on signOutAll, with no POST /logout', async () => {
    const net = fakeNetwork('rotate');
    const { svc } = await startReal();

    await firstValueFrom(svc.signOutAll());

    expect([...net.revocations].sort()).toEqual([
      'access_token',
      'refresh_token',
    ]);
    expect(net.calls.some((call) => call.endsWith('/logout'))).toBe(false);
  });

  it('logs a stored session with no live client out through a detached client', async () => {
    const net = fakeNetwork('rotate');
    await useRealClients();
    const { svc } = setup();

    await svc.detachedClient(OIDC_SESSION).logout(true);

    const opts = vi.mocked(createClient).mock.calls.at(-1)![0];
    expect(opts).toMatchObject({
      baseUrl: 'https://hs.example',
      userId: '@me:hs',
      deviceId: 'DEV',
      accessToken: 'tok',
      refreshToken: 'refresh-tok',
      oauthClientId: 'client-1',
    });
    // No persistent store: createClient() fills in its in-memory default, on these same opts.
    expect(opts.store).toBeInstanceOf(MemoryStore);
    expect([...net.revocations].sort()).toEqual([
      'access_token',
      'refresh_token',
    ]);
    expect(svc.accountIds()).toEqual([]);
  });
});
