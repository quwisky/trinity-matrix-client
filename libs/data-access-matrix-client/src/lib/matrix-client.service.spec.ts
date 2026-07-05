import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { ClientEvent, SyncState, createClient } from 'matrix-js-sdk';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from './matrix-client.service';
import { SessionStorageService } from '@trinity/platform-native';
import { SecretStorageKeyService } from './secret-storage-key.service';

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

function fakeClient() {
  return {
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
    providers: [
      MatrixClientService,
      MockProvider(SessionStorageService),
      MockProvider(SecretStorageKeyService),
    ],
  });
  const svc = TestBed.inject(MatrixClientService);
  const storage = TestBed.inject(SessionStorageService);
  const keys = TestBed.inject(SecretStorageKeyService);
  // Default: no persisted session (mirrors the original hand-rolled stub); the
  // save/clear observables aren't exercised by these paths.
  vi.mocked(storage.load).mockReturnValue(of(null));
  return { svc, storage, keys };
}

describe('MatrixClientService', () => {
  beforeEach(() => {
    vi.mocked(createClient).mockReset();
    storeMock.startup.mockReset().mockResolvedValue(undefined);
    storeMock.destroy.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllGlobals());

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
    expect(client.startClient).toHaveBeenCalledOnce();
    expect(svc.isInitialized).toBe(true);
    expect(svc.instance).toBe(client);
  });

  it('does not publish the client until startClient resolves', async () => {
    const client = fakeClient();
    client.startClient.mockRejectedValue(new Error('sync failed'));
    vi.mocked(createClient).mockReturnValue(client as never);
    const { svc, keys } = setup();

    await expect(firstValueFrom(svc.init(SESSION))).rejects.toThrow(
      'sync failed',
    );
    // Rolled back: client stopped, 4S key cleared, nothing left half-initialized.
    expect(client.stopClient).toHaveBeenCalled();
    expect(keys.clear).toHaveBeenCalled();
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
    const { svc, keys } = setup();
    await firstValueFrom(svc.init(SESSION));
    keys.clear.mockClear();

    await firstValueFrom(svc.reset());

    expect(client.stopClient).toHaveBeenCalled();
    expect(client.clearStores).toHaveBeenCalledOnce();
    expect(keys.clear).toHaveBeenCalled();
    expect(svc.isInitialized).toBe(false);
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
});
