import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import {
  ClientEvent,
  HttpApiEvent,
  SyncState,
  createClient,
} from 'matrix-js-sdk';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from './matrix-client.service';
import { SessionStorageService } from '@trinity/platform-native';
import { SecretStorageKeyHolder } from './secret-storage-key-holder';

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
// now lives in @trinity/util-matrix; partial-mock so its other exports stay real.
vi.mock('@trinity/util-matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util-matrix')>()),
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
  // Default: no persisted session (mirrors the original hand-rolled stub); the
  // save/clear observables aren't exercised by these paths.
  vi.mocked(storage.load).mockReturnValue(of(null));
  // restoreAll fires an orphan sweep; default it to a no-op so restore paths don't NPE.
  vi.mocked(storage.sweepOrphanedCryptoStores).mockReturnValue(of(undefined));
  return { svc, storage };
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

  it('wires refresh-token auto-renewal for an OIDC session', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();

    await firstValueFrom(svc.init(OIDC_SESSION));

    const opts = vi.mocked(createClient).mock.calls[0][0];
    expect(opts.refreshToken).toBe('refresh-tok');
    expect(typeof opts.tokenRefreshFunction).toBe('function');
  });

  it('passes no refresh wiring for a non-OIDC (password/SSO) session', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();

    await firstValueFrom(svc.init(SESSION));

    const opts = vi.mocked(createClient).mock.calls[0][0];
    expect(opts.refreshToken).toBeUndefined();
    expect(opts.tokenRefreshFunction).toBeUndefined();
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

  it('bridges sync state into the signal', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));

    // Grab the ClientEvent.Sync handler the service registered and fire it.
    const syncCall = client.on.mock.calls.find(([evt]) => evt === 'sync');
    expect(syncCall).toBeTruthy();
    syncCall![1]('SYNCING');
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

  it('restoreAll flags a token-less stored account as needing re-auth', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc, storage } = setup();
    vi.mocked(storage.list).mockReturnValue(
      of([
        { baseUrl: 'https://hs.example', userId: '@me:hs', deviceId: 'DEV' },
        { baseUrl: 'https://hs.example', userId: '@ghost:hs', deviceId: 'DV2' },
      ]) as never,
    );
    // The active account still has a token; the ghost's was dropped by a soft-logout.
    vi.mocked(storage.load).mockImplementation(((userId?: string) =>
      of(userId === '@ghost:hs' ? null : SESSION)) as never);

    await firstValueFrom(svc.restoreAll());

    expect(svc.isInitialized).toBe(true); // active account restored
    expect(svc.softLoggedOut()).toContain('@ghost:hs'); // ghost surfaced for re-auth
  });

  it('restore() inits from a stored session, else resolves false', async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc, storage } = setup();

    storage.load.mockReturnValue(of(SESSION));
    await expect(firstValueFrom(svc.restore())).resolves.toBe(true);
    expect(svc.isInitialized).toBe(true);

    await firstValueFrom(svc.stop());
    storage.load.mockReturnValue(of(null));
    await expect(firstValueFrom(svc.restore())).resolves.toBe(false);
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
    expect(svc.connectivity()).toBe('offline');
    onSync(SyncState.Reconnecting);
    expect(svc.connectivity()).toBe('offline');
    onSync(SyncState.Syncing);
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

  it('warm() starts an account without making it active', async () => {
    const a = fakeClient();
    const b = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a as never)
      .mockReturnValueOnce(b as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION)); // A active
    await firstValueFrom(svc.warm(SESSION_B)); // B added, NOT active

    expect(svc.activeUserId()).toBe('@me:hs'); // still A
    expect(svc.instance).toBe(a);
    expect([...svc.accountIds()].sort()).toEqual(['@me:hs', '@you:other']);
  });

  it('clientFor() returns the account client, or null', async () => {
    const a = fakeClient();
    vi.mocked(createClient).mockReturnValue(a as never);
    const { svc } = setup();
    await firstValueFrom(svc.init(SESSION));

    expect(svc.clientFor('@me:hs')).toBe(a);
    expect(svc.clientFor('@nobody:hs')).toBeNull();
  });

  it('restoreAll() starts the active account first and warms the others', async () => {
    const a = fakeClient();
    const b = fakeClient();
    vi.mocked(createClient)
      .mockReturnValueOnce(a as never)
      .mockReturnValueOnce(b as never);
    const { svc, storage } = setup();
    vi.mocked(storage.list).mockReturnValue(
      of([{ userId: '@me:hs' }, { userId: '@you:other' }]) as never,
    );
    // load() → active (SESSION @me:hs); load(userId) → that account's session.
    vi.mocked(storage.load).mockImplementation(
      (userId?: string) =>
        of(userId === '@you:other' ? SESSION_B : SESSION) as never,
    );

    expect(await firstValueFrom(svc.restoreAll())).toBe(true);
    expect(svc.activeUserId()).toBe('@me:hs'); // active restored first

    // The others warm in the background (fire-and-forget) — let it settle.
    await new Promise((r) => setTimeout(r, 0));
    expect([...svc.accountIds()].sort()).toEqual(['@me:hs', '@you:other']);
    expect(svc.activeUserId()).toBe('@me:hs'); // warming didn't steal active
  });

  it('restoreAll() resolves false when nothing is stored', async () => {
    const { svc, storage } = setup();
    vi.mocked(storage.list).mockReturnValue(of([]) as never);
    expect(await firstValueFrom(svc.restoreAll())).toBe(false);
    expect(svc.isInitialized).toBe(false);
  });

  it('restoreAll() sweeps orphaned crypto stores on cold start (even with none stored)', async () => {
    const { svc, storage } = setup();
    vi.mocked(storage.list).mockReturnValue(of([]) as never);
    await firstValueFrom(svc.restoreAll());
    // Best-effort disk hygiene must run at startup regardless of the restore outcome.
    expect(storage.sweepOrphanedCryptoStores).toHaveBeenCalledOnce();
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
    expect(svc.syncState()).toBe('SYNCING');

    // Re-add the SAME active account: fresh client + fresh per-account syncState
    // signal, active id net-unchanged.
    await firstValueFrom(svc.add(SESSION));
    expect(svc.syncState()).toBeNull(); // re-bound to a2's untransitioned signal

    syncOf(a2)(SyncState.Error); // only the NEW client's listener now feeds state
    expect(svc.connectivity()).toBe('offline');
  });

  it('restoreAll isolates a failing warmed background account', async () => {
    const a = fakeClient();
    const b = fakeClient();
    b.startClient.mockRejectedValue(new Error('sync boom'));
    vi.mocked(createClient)
      .mockReturnValueOnce(a as never)
      .mockReturnValueOnce(b as never);
    const { svc, storage } = setup();
    vi.mocked(storage.list).mockReturnValue(
      of([{ userId: '@me:hs' }, { userId: '@you:other' }]) as never,
    );
    vi.mocked(storage.load).mockImplementation(
      (userId?: string) =>
        of(userId === '@you:other' ? SESSION_B : SESSION) as never,
    );

    expect(await firstValueFrom(svc.restoreAll())).toBe(true); // active still up
    expect(svc.activeUserId()).toBe('@me:hs');
    expect(svc.isInitialized).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0)); // let the warm fail out

    expect([...svc.accountIds()]).toEqual(['@me:hs']); // the failing account never joined
    expect(b.stopClient).toHaveBeenCalled(); // its half-started client rolled back
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

  describe('CORS origin publishing (desktop)', () => {
    // On desktop the renderer must publish the live homeserver origin set so main's CORS
    // shim can be scoped to it (electron/src/cors.ts). Published on every account-set
    // change; the whole set is REPLACED each time so a signed-out account is revoked.
    it('publishes the live homeserver origins whenever the account set changes', async () => {
      const setAllowedOrigins = vi.fn();
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
        cors: { setAllowedOrigins, allowOrigin: vi.fn() },
      };
      try {
        vi.mocked(createClient).mockReturnValueOnce(
          fakeClient('https://hs.example') as never,
        );
        const { svc, storage } = setup();
        vi.mocked(storage.save).mockReturnValue(of(SESSION as never));
        vi.mocked(storage.setActive).mockReturnValue(of(undefined));

        await firstValueFrom(svc.init(SESSION));
        expect(setAllowedOrigins).toHaveBeenLastCalledWith([
          'https://hs.example',
        ]);

        // A second account joins → the set now carries both origins.
        vi.mocked(createClient).mockReturnValueOnce(
          fakeClient('https://other.example') as never,
        );
        vi.mocked(storage.save).mockReturnValue(of(SESSION_B as never));
        await firstValueFrom(svc.add(SESSION_B));
        expect(setAllowedOrigins).toHaveBeenLastCalledWith([
          'https://hs.example',
          'https://other.example',
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
