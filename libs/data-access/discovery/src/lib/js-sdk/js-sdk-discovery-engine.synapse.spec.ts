import { Injector } from '@angular/core';
import { createHmac } from 'node:crypto';
import { createClient } from 'matrix-js-sdk';
import { describe } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineDiscoveryEngineContract } from '../../contract/discovery-engine.contract';
import { JsSdkDiscoveryEngine } from './js-sdk-discovery-engine';

// Runs the engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';
const domain = process.env['TRINITY_ENGINE_CONTRACT_DOMAIN'] ?? serverName;

async function register(username: string) {
  const api = `${baseUrl}/_synapse/admin/v1/register`;
  const { nonce } = (await (await fetch(api)).json()) as { nonce: string };
  const password = `pw-${Math.random().toString(36).slice(2)}`;
  const mac = createHmac('sha1', secret)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await fetch(api, {
    method: 'POST',
    body: JSON.stringify({ nonce, username, password, mac, admin: false }),
  });
  const body = (await res.json()) as { user_id: string; access_token: string };
  return {
    userId: body.user_id,
    client: createClient({
      baseUrl: baseUrl as string,
      userId: body.user_id,
      accessToken: body.access_token,
    }),
  };
}

describe.skipIf(!baseUrl)('JsSdkDiscoveryEngine against Synapse', () => {
  defineDiscoveryEngineContract(async () => {
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
      otherUser: { userId: other.userId, displayName },
    };
  });
});
