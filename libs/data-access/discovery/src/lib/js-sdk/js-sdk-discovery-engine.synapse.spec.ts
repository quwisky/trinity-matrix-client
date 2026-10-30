import { Injector } from '@angular/core';
import { createHmac } from 'node:crypto';
import { ClientEvent, type MatrixClient, createClient } from 'matrix-js-sdk';
import { afterAll, beforeAll, describe } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineDiscoveryEngineContract } from '../../contract/discovery-engine.contract';
import { JsSdkDiscoveryEngine } from './js-sdk-discovery-engine';

// Runs the engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';
const domain = process.env['TRINITY_ENGINE_CONTRACT_DOMAIN'] ?? serverName;

async function register(username: string, admin = false) {
  const api = `${baseUrl}/_synapse/admin/v1/register`;
  const nonceRes = await fetch(api);
  if (!nonceRes.ok)
    throw new Error(`Synapse nonce request failed: ${nonceRes.status}`);
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const password = `pw-${Math.random().toString(36).slice(2)}`;
  const mac = createHmac('sha1', secret)
    .update(
      `${nonce}\0${username}\0${password}\0${admin ? 'admin' : 'notadmin'}`,
    )
    .digest('hex');
  const res = await fetch(api, {
    method: 'POST',
    body: JSON.stringify({ nonce, username, password, mac, admin }),
  });
  if (!res.ok) throw new Error(`Synapse registration failed: ${res.status}`);
  const body = (await res.json()) as { user_id: string; access_token: string };
  return {
    userId: body.user_id,
    accessToken: body.access_token,
    client: createClient({
      baseUrl: baseUrl as string,
      userId: body.user_id,
      accessToken: body.access_token,
    }),
  };
}

// A fresh Synapse rebuilds its user directory in a background update and drops users
// registered meanwhile, so the contract users are only created once it has finished.
async function waitForBackgroundUpdates(): Promise<void> {
  const admin = await register(`admin-${Date.now().toString(36)}`, true);
  for (let i = 0; i < 240; i++) {
    const res = await fetch(
      `${baseUrl}/_synapse/admin/v1/background_updates/status`,
      { headers: { authorization: `Bearer ${admin.accessToken}` } },
    );
    if (!res.ok)
      throw new Error(`Synapse background update status failed: ${res.status}`);
    const { current_updates } = (await res.json()) as {
      current_updates: Record<string, unknown>;
    };
    if (Object.keys(current_updates).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Synapse background updates did not finish');
}

describe.skipIf(!baseUrl)('JsSdkDiscoveryEngine against Synapse', () => {
  // Stopping a client aborts its in-flight /sync long-poll and the SDK leaves that rejection
  // unhandled; Vitest would fail the run for it, so only that abort is kept from Vitest.
  let listeners: NodeJS.UnhandledRejectionListener[] = [];
  let syncing: MatrixClient | undefined;
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
    syncing?.stopClient();
    process.removeListener('unhandledRejection', ignoreSyncAbort);
    for (const listener of listeners)
      process.on('unhandledRejection', listener);
  });

  defineDiscoveryEngineContract(async () => {
    await waitForBackgroundUpdates();
    const unique = Date.now().toString(36);
    const [me, other] = await Promise.all([
      register(`disc-a-${unique}`),
      register(`disc-b-${unique}`),
    ]);
    const displayName = `Other ${unique}`;
    const name = `Room ${unique}`;
    const alias = `#room-${unique}:${serverName}`;
    await other.client.setDisplayName(displayName);
    const { room_id: roomId } = await other.client.createRoom({
      visibility: 'public' as never,
      preset: 'public_chat' as never,
      name,
      room_alias_name: `room-${unique}`,
    });
    const unjoinedName = `Plaza ${unique}`;
    const { room_id: unjoinedId } = await other.client.createRoom({
      visibility: 'public' as never,
      preset: 'public_chat' as never,
      name: unjoinedName,
      room_alias_name: `plaza-${unique}`,
    });
    const { room_id: knockId } = await other.client.createRoom({
      name: `Door ${unique}`,
      initial_state: [
        {
          type: 'm.room.join_rules',
          state_key: '',
          content: { join_rule: 'knock' },
        },
      ],
    });
    // Public, so no encryption: only the synced room can then say it is unencrypted.
    const joinedName = `Mine ${unique}`;
    const { room_id: joinedId } = await me.client.createRoom({
      preset: 'public_chat' as never,
      name: joinedName,
    });
    const synced = new Promise<void>((resolve) => {
      const check = () => {
        if (me.client.getRoom(joinedId)?.getMyMembership() === 'join') {
          me.client.off(ClientEvent.Sync, check);
          resolve();
        }
      };
      me.client.on(ClientEvent.Sync, check);
    });
    await me.client.startClient({ initialSyncLimit: 1 });
    syncing = me.client;
    await synced;
    for (let i = 0; i < 20; i++) {
      const { results } = await me.client.searchUserDirectory({
        term: displayName,
      });
      if (results.some((user) => user.user_id === other.userId)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const engine = Injector.create({
      providers: [
        {
          provide: JS_SDK_CLIENTS,
          useValue: {
            clientFor: (id: string) => (id === me.userId ? me.client : null),
          },
        },
        JsSdkDiscoveryEngine,
      ],
    }).get(JsSdkDiscoveryEngine);
    return {
      engine,
      accountId: me.userId,
      domain,
      publicRoom: { roomId, name, alias },
      unjoinedRoom: {
        roomId: unjoinedId,
        name: unjoinedName,
        alias: `#plaza-${unique}:${serverName}`,
      },
      joinedRoom: { roomId: joinedId, name: joinedName },
      knockRoom: { roomId: knockId },
      otherUser: { userId: other.userId, displayName },
    };
  });
});
