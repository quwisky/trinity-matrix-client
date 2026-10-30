import { Injector } from '@angular/core';
import { createHmac } from 'node:crypto';
import {
  ClientEvent,
  type MatrixClient,
  SyncState,
  createClient,
} from 'matrix-js-sdk';
import { afterAll, beforeAll, describe } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineIdentityEngineContract } from '../../contract/identity-engine.contract';
import { JsSdkIdentityEngine } from './js-sdk-identity-engine';

// Runs the engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

async function register(username: string): Promise<MatrixClient> {
  const api = `${baseUrl}/_synapse/admin/v1/register`;
  const nonceRes = await fetch(api);
  if (!nonceRes.ok)
    throw new Error(`Synapse nonce request failed: ${nonceRes.status}`);
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const password = `pw-${Math.random().toString(36).slice(2)}`;
  const mac = createHmac('sha1', secret)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await fetch(api, {
    method: 'POST',
    body: JSON.stringify({ nonce, username, password, mac, admin: false }),
  });
  if (!res.ok) throw new Error(`Synapse registration failed: ${res.status}`);
  const body = (await res.json()) as { user_id: string; access_token: string };
  return createClient({
    baseUrl: baseUrl as string,
    userId: body.user_id,
    accessToken: body.access_token,
  });
}

function startSyncing(client: MatrixClient): Promise<void> {
  const synced = new Promise<void>((resolve) => {
    const check = (state: SyncState) => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        client.off(ClientEvent.Sync, check);
        resolve();
      }
    };
    client.on(ClientEvent.Sync, check);
  });
  return client.startClient({ initialSyncLimit: 1 }).then(() => synced);
}

describe.skipIf(!baseUrl)('JsSdkIdentityEngine against Synapse', () => {
  // Stopping a client aborts its in-flight /sync long-poll and the SDK leaves that rejection
  // unhandled; Vitest would fail the run for it, so only that abort is kept from Vitest.
  let listeners: NodeJS.UnhandledRejectionListener[] = [];
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
    process.removeListener('unhandledRejection', ignoreSyncAbort);
    for (const listener of listeners)
      process.on('unhandledRejection', listener);
  });

  defineIdentityEngineContract(
    async () => {
      const unique = Date.now().toString(36);
      const [alice, bob, carol] = await Promise.all([
        register(`id-a-${unique}`),
        register(`id-b-${unique}`),
        register(`id-c-${unique}`),
      ]);
      const aliceId = alice.getUserId() as string;
      const bobId = bob.getUserId() as string;
      const knownUser = {
        userId: carol.getUserId() as string,
        displayName: `Carol ${unique}`,
        avatarMxc: `mxc://${serverName}/id-c-${unique}`,
      };
      await carol.setDisplayName(knownUser.displayName);
      await carol.setAvatarUrl(knownUser.avatarMxc);
      // A shared room: Synapse sends presence only to users who share one. Carol's join
      // carries her profile into alice's first sync.
      const { room_id: roomId } = await alice.createRoom({
        invite: [bobId, knownUser.userId],
      });
      await Promise.all([bob.joinRoom(roomId), carol.joinRoom(roomId)]);
      await Promise.all([startSyncing(alice), startSyncing(bob)]);

      const clients = new Map([
        [aliceId, alice],
        [bobId, bob],
      ]);
      const engine = Injector.create({
        providers: [
          {
            provide: JS_SDK_CLIENTS,
            useValue: { clientFor: (id: string) => clients.get(id) ?? null },
          },
          JsSdkIdentityEngine,
        ],
      }).get(JsSdkIdentityEngine);
      return {
        engine,
        alice: aliceId,
        bob: bobId,
        unknownUser: `@id-ghost-${unique}:${serverName}`,
        knownUser,
        avatars: [
          `mxc://${serverName}/id-a-${unique}`,
          `mxc://${serverName}/id-b-${unique}`,
        ] as const,
        dispose: () => {
          alice.stopClient();
          bob.stopClient();
          return Promise.resolve();
        },
      };
    },
    { settleTimeoutMs: 20_000, testTimeoutMs: 60_000 },
  );
});
