import { TestBed } from '@angular/core/testing';
import { createHmac } from 'node:crypto';
import {
  ClientEvent,
  MatrixClient,
  SyncState,
  createClient,
} from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of, tap, toArray } from 'rxjs';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  MatrixClientService,
  SESSION_ENGINE,
} from '@trinity/data-access/matrix-client';
import {
  CryptoStoreKeyService,
  SessionStorageService,
} from '@trinity/platform-native';
import { AUTH_METADATA } from '../auth-metadata.fixture';
import { JsSdkQrRendezvous, QrRendezvousFactory } from './qr-rendezvous';

// jsdom serves no crypto .wasm to the preload; initRustCrypto loads its own.
vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
});

// The secrets stage of a QR sign-in with real Rust crypto: the new device holds an existing
// device's bundle at `done`, and the session engine's start of that user and device imports
// it. The rendezvous itself needs MAS or Tuwunel's OAuth server, so a stand-in flow carries
// the bundle. Skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'] as string;
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

async function register(localpart: string) {
  const api = `${baseUrl}/_synapse/admin/v1/register`;
  const { nonce } = (await (await fetch(api)).json()) as { nonce: string };
  const password = `pw-${Math.random().toString(36).slice(2)}`;
  const mac = createHmac('sha1', secret)
    .update(`${nonce}\0${localpart}\0${password}\0notadmin`)
    .digest('hex');
  const res = await fetch(api, {
    method: 'POST',
    body: JSON.stringify({ nonce, username: localpart, password, mac }),
  });
  if (!res.ok) throw new Error(`Synapse registration failed: ${res.status}`);
  const { user_id } = (await res.json()) as { user_id: string };
  return { userId: user_id, password };
}

/** A new device's session for `user`, with no client running on it yet. */
async function login(user: { userId: string; password: string }) {
  const res = await fetch(`${baseUrl}/_matrix/client/v3/login`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: user.userId },
      password: user.password,
    }),
  });
  if (!res.ok) throw new Error(`Synapse login failed: ${res.status}`);
  return (await res.json()) as { device_id: string; access_token: string };
}

/** Signs `user` in on a device with in-memory Rust crypto and its own cross-signing. */
async function startExistingDevice(user: { userId: string; password: string }) {
  const session = await login(user);
  const client = createClient({
    baseUrl,
    userId: user.userId,
    deviceId: session.device_id,
    accessToken: session.access_token,
  });
  await client.initRustCrypto({ useIndexedDB: false });
  const prepared = new Promise<void>((resolve) => {
    const onSync = (state: SyncState) => {
      if (state !== SyncState.Prepared) return;
      client.off(ClientEvent.Sync, onSync);
      resolve();
    };
    client.on(ClientEvent.Sync, onSync);
  });
  await client.startClient({ initialSyncLimit: 0 });
  await prepared;
  const crypto = client.getCrypto();
  if (!crypto?.exportSecretsBundle) throw new Error('No secrets export');
  await crypto.bootstrapCrossSigning({
    setupNewCrossSigning: true,
    authUploadDeviceSigningKeys: async (makeRequest) => {
      await makeRequest({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: user.userId },
        password: user.password,
      });
    },
  });
  return { client, bundle: await crypto.exportSecretsBundle() };
}

describe.skipIf(!baseUrl)('JsSdkQrRendezvous against Synapse', () => {
  const clients: MatrixClient[] = [];
  let listeners: NodeJS.UnhandledRejectionListener[] = [];
  // A stopped client leaves its sync abort unhandled; nothing else may be swallowed.
  const ignoreSyncAbort = (reason: unknown, promise: Promise<unknown>) => {
    if ((reason as { name?: string } | null)?.name === 'AbortError') return;
    for (const listener of listeners) listener(reason, promise);
  };
  beforeAll(() => {
    listeners = process.listeners(
      'unhandledRejection',
    ) as NodeJS.UnhandledRejectionListener[];
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', ignoreSyncAbort);
  });
  afterAll(() => {
    for (const client of clients) client.stopClient();
    process.removeListener('unhandledRejection', ignoreSyncAbort);
    for (const listener of listeners)
      process.on('unhandledRejection', listener);
  });

  beforeEach(() => {
    // jsdom has no IndexedDB, so the started session's crypto store lives in memory.
    const init = MatrixClient.prototype.initRustCrypto;
    vi.spyOn(MatrixClient.prototype, 'initRustCrypto').mockImplementation(
      function (this: MatrixClient) {
        return init.call(this, { useIndexedDB: false });
      },
    );
    TestBed.configureTestingModule({
      providers: [
        MockProvider(SessionStorageService, {
          record: () => of(null),
          invalidateToken: () => of(void 0),
          remove: () => of(void 0),
          setActive: () => of(void 0),
          updateTokens: () => of(void 0),
        }),
        MockProvider(CryptoStoreKeyService),
      ],
    });
  });

  afterEach(async () => {
    await firstValueFrom(TestBed.inject(SESSION_ENGINE).stop());
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  /**
   * Runs a QR sign-in whose grant issues `token`, with the other device sharing `bundle`, to
   * its end. The stand-in shows check code 07, which the person types.
   */
  async function signIn(token: string, bundle: unknown) {
    const flow = {
      code: new Uint8Array([1]),
      checkCode: '07',
      generateCode: async () => undefined,
      negotiateProtocols: async () => ({ serverName: 'localhost' }),
      deviceAuthorizationGrant: async () => ({ userCode: 'CODE' }),
      completeLoginOnNewDevice: async () => ({
        access_token: token,
        token_type: 'Bearer',
      }),
      shareSecrets: async () => ({ secrets: bundle }),
      cancel: async () => undefined,
      close: async () => undefined,
    };
    TestBed.configureTestingModule({
      providers: [
        {
          provide: QrRendezvousFactory,
          useValue: { newDevice: async () => ({ flow, expires: null }) },
        },
      ],
    });
    const qr = TestBed.inject(JsSdkQrRendezvous);
    return firstValueFrom(
      qr
        .signInWithQr(baseUrl, {
          grantMetadata: AUTH_METADATA,
          clientId: 'contract-client',
        })
        .pipe(
          tap((update) => {
            if (update.kind === 'enter-check-code') {
              qr.answerQrSignIn(update.flowId, { checkCode: '07' }).subscribe();
            }
          }),
          toArray(),
        ),
    );
  }

  /** Starts the session as an added account does, then reads whether it is cross-signed. */
  async function startAndCheck(session: {
    userId: string;
    deviceId: string;
    accessToken: string;
  }) {
    await expect(
      firstValueFrom(
        TestBed.inject(SESSION_ENGINE).restorePersisted(
          { baseUrl, ...session },
          'background',
        ),
      ),
    ).resolves.toEqual({ ok: true, value: null });
    const client = TestBed.inject(MatrixClientService).clientFor(
      session.userId,
    );
    const status = await client
      ?.getCrypto()
      ?.getDeviceVerificationStatus(session.userId, session.deviceId);
    return status?.crossSigningVerified === true;
  }

  it('hands over the session at done, and starting that user and device ends cross-signed', async () => {
    const user = await register(`auth-qr-${Date.now().toString(36)}`);
    const existing = await startExistingDevice(user);
    clients.push(existing.client);
    const fresh = await login(user);

    const updates = await signIn(fresh.access_token, existing.bundle);

    const done = updates.at(-1);
    expect(done).toEqual({
      kind: 'done',
      session: {
        homeserverUrl: baseUrl,
        userId: user.userId,
        deviceId: fresh.device_id,
        accessToken: fresh.access_token,
        refreshToken: null,
        accessTokenExpiresAt: null,
      },
    });
    expect(JSON.stringify(updates)).not.toContain(
      JSON.stringify(existing.bundle.cross_signing),
    );
    await expect(
      startAndCheck({
        userId: user.userId,
        deviceId: fresh.device_id,
        accessToken: fresh.access_token,
      }),
    ).resolves.toBe(true);
  }, 120_000);

  it('leaves another device of the same account unverified', async () => {
    const user = await register(`auth-qr-other-${Date.now().toString(36)}`);
    const existing = await startExistingDevice(user);
    clients.push(existing.client);
    const fresh = await login(user);
    const other = await login(user);

    const updates = await signIn(fresh.access_token, existing.bundle);
    expect(updates.at(-1)?.kind).toBe('done');

    await expect(
      startAndCheck({
        userId: user.userId,
        deviceId: other.device_id,
        accessToken: other.access_token,
      }),
    ).resolves.toBe(false);
  }, 120_000);
});
