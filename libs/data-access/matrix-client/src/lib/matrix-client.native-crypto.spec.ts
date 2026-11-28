import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { createClient } from 'matrix-js-sdk';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CryptoStoreKeyService,
  type NativeCryptoHost,
  NativeCryptoService,
  SessionStorageService,
} from '@trinity/platform-native';
import type { MatrixSession } from '@trinity/util/matrix';
import { MatrixClientService } from './matrix-client.service';
import { SESSION, fakeClient } from './matrix-client.spec-harness';

const storeMock = vi.hoisted(() => ({ startup: vi.fn(), destroy: vi.fn() }));

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

vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
});

const NATIVE: MatrixSession = {
  ...SESSION,
  cryptoPrefix: 'trinity-crypto:@me:hs:DEV',
  cryptoBackend: 'native',
};

/** A native host whose machine-lost listeners the test can fire. */
function fakeHost() {
  const lost = new Map<string, () => void>();
  const host = {
    install: vi.fn(async () => undefined),
    onMachineLost: vi.fn(
      (userId: string, deviceId: string, listener: () => void) => {
        lost.set(`${userId}|${deviceId}`, listener);
        return () => lost.delete(`${userId}|${deviceId}`);
      },
    ),
    deleteStore: vi.fn(async () => undefined),
    deleteStores: vi.fn(async () => undefined),
  } satisfies NativeCryptoHost;
  return { host, lost };
}

function setup(host: NativeCryptoHost | null) {
  const client = fakeClient();
  vi.mocked(createClient).mockReturnValue(client as never);
  TestBed.configureTestingModule({
    providers: [
      MatrixClientService,
      MockProvider(SessionStorageService),
      MockProvider(CryptoStoreKeyService),
    ],
  });
  const native = TestBed.inject(NativeCryptoService);
  vi.spyOn(native, 'host').mockResolvedValue(host);
  const storage = TestBed.inject(SessionStorageService);
  vi.mocked(storage.load).mockReturnValue(of(null));
  vi.mocked(storage.record).mockReturnValue(of(null));
  const storeKeys = TestBed.inject(CryptoStoreKeyService);
  return {
    svc: TestBed.inject(MatrixClientService),
    client,
    storage,
    storeKeys,
  };
}

describe('MatrixClientService on native crypto', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('installs the shim and opens a native session without a store key', async () => {
    const { host } = fakeHost();
    const { svc, client, storeKeys } = setup(host);

    await expect(
      firstValueFrom(svc.restorePersisted(NATIVE, 'activate')),
    ).resolves.toEqual({ kind: 'ready' });

    expect(host.install).toHaveBeenCalledTimes(1);
    expect(storeKeys.read).not.toHaveBeenCalled();
    expect(client.initRustCrypto).toHaveBeenCalledWith({
      cryptoDatabasePrefix: NATIVE.cryptoPrefix,
    });
  });

  it.each([
    ['an unmarked session on a native host', fakeHost().host, SESSION],
    ['a native session where crypto is not native', null, NATIVE],
  ])('refuses %s and opens no store', async (_case, host, session) => {
    const { svc, client } = setup(host);

    await expect(
      firstValueFrom(svc.restorePersisted(session, 'activate')),
    ).resolves.toEqual({ kind: 'failed', failure: 'crypto-backend-mismatch' });

    expect(client.initRustCrypto).not.toHaveBeenCalled();
    if (host) expect(host.install).not.toHaveBeenCalled();
  });

  it('stops the client and reports the account when its machine is lost', async () => {
    const { host, lost } = fakeHost();
    const { svc, client } = setup(host);
    const reported: string[] = [];
    svc.cryptoLost.subscribe((id) => reported.push(id));
    await firstValueFrom(svc.restorePersisted(NATIVE, 'activate'));
    client.stopClient.mockClear();

    lost.get(`${NATIVE.userId}|${NATIVE.deviceId}`)!();

    expect(client.stopClient).toHaveBeenCalledTimes(1);
    expect(reported).toEqual([NATIVE.userId]);
  });

  it('deletes the native store on sign-out, after the client stopped, and stops listening', async () => {
    const { host, lost } = fakeHost();
    const { svc, client } = setup(host);
    await firstValueFrom(svc.restorePersisted(NATIVE, 'activate'));

    await firstValueFrom(svc.remove(NATIVE.userId));

    await vi.waitFor(() =>
      expect(host.deleteStore).toHaveBeenCalledWith(
        NATIVE.userId,
        NATIVE.deviceId,
      ),
    );
    expect(client.stopClient.mock.invocationCallOrder[0]).toBeLessThan(
      host.deleteStore.mock.invocationCallOrder[0],
    );
    expect(lost.size).toBe(0);
  });

  it('deletes the native store of a signed-out account that is not running', async () => {
    vi.stubGlobal('indexedDB', { deleteDatabase: vi.fn() });
    const { host } = fakeHost();
    const { svc, storage } = setup(host);
    vi.mocked(storage.record).mockReturnValue(of(NATIVE));

    await firstValueFrom(svc.remove(NATIVE.userId));

    await vi.waitFor(() =>
      expect(host.deleteStore).toHaveBeenCalledWith(
        NATIVE.userId,
        NATIVE.deviceId,
      ),
    );
  });
});
