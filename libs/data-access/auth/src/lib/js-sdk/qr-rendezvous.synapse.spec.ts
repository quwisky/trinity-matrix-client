import { TestBed } from '@angular/core/testing';
import { createHmac } from 'node:crypto';
import {
  ClientEvent,
  SyncState,
  createClient,
  type MatrixClient,
} from 'matrix-js-sdk';
import { firstValueFrom, tap, toArray } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { AUTH_METADATA } from '../auth-metadata.fixture';
import { JsSdkQrRendezvous, QrRendezvousFactory } from './qr-rendezvous';

// The secrets stage of a QR sign-in with real Rust crypto: an existing device's bundle is
// imported into the new device's live session. The rendezvous itself needs MAS or Tuwunel's
// OAuth server, so a stand-in flow carries the bundle. Skipped unless TRINITY_ENGINE_CONTRACT_HS
// is set.
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

/** Signs `user` in on a new device: a client with in-memory Rust crypto, synced. */
async function startDevice(user: { userId: string; password: string }) {
  const res = await fetch(`${baseUrl}/_matrix/client/v3/login`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: user.userId },
      password: user.password,
    }),
  });
  if (!res.ok) throw new Error(`Synapse login failed: ${res.status}`);
  const session = (await res.json()) as {
    device_id: string;
    access_token: string;
  };
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
  return { client, accessToken: session.access_token };
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

  it('imports the secrets another device shares into the new session, which ends verified', async () => {
    const user = await register(`auth-qr-${Date.now().toString(36)}`);
    const existing = await startDevice(user);
    clients.push(existing.client);
    const existingCrypto = existing.client.getCrypto();
    if (!existingCrypto?.exportSecretsBundle) {
      throw new Error('No secrets export');
    }
    await existingCrypto.bootstrapCrossSigning({
      setupNewCrossSigning: true,
      authUploadDeviceSigningKeys: async (makeRequest) => {
        await makeRequest({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: user.userId },
          password: user.password,
        });
      },
    });
    const bundle = await existingCrypto.exportSecretsBundle();
    const fresh = await startDevice(user);
    clients.push(fresh.client);
    // Stands in for the rendezvous: the grant issues the new device's token, and the
    // existing device shares its bundle once the new session is established.
    const flow = {
      code: new Uint8Array([1]),
      checkCode: '00',
      generateCode: async () => undefined,
      negotiateProtocols: async () => ({ serverName: 'localhost' }),
      deviceAuthorizationGrant: async () => ({ userCode: 'CODE' }),
      completeLoginOnNewDevice: async () => ({
        access_token: fresh.accessToken,
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
        {
          provide: JS_SDK_CLIENTS,
          useValue: {
            clientFor: (id: string) =>
              id === user.userId ? fresh.client : null,
            holderFor: () => null,
          },
        },
      ],
    });
    const qr = TestBed.inject(JsSdkQrRendezvous);

    const updates = await firstValueFrom(
      qr
        .signInWithQr(baseUrl, {
          grantMetadata: AUTH_METADATA,
          clientId: 'contract-client',
        })
        .pipe(
          tap((update) => {
            if (update.kind === 'server-reported') {
              qr.answerQrSignIn(update.flowId, {
                kind: 'server-accepted',
              }).subscribe();
            } else if (update.kind === 'signed-in') {
              qr.continueQrSignIn(update.flowId, update.userId).subscribe();
            }
          }),
          toArray(),
        ),
    );

    expect(updates.find((u) => u.kind === 'signed-in')).toMatchObject({
      userId: user.userId,
      deviceId: fresh.client.getDeviceId(),
    });
    expect(updates.at(-1)).toEqual({ kind: 'done', verified: true });
    expect(JSON.stringify(updates)).not.toContain(
      JSON.stringify(bundle.cross_signing),
    );
  }, 120_000);
});
