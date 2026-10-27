import { Injector } from '@angular/core';
import { createHmac } from 'node:crypto';
import { createClient } from 'matrix-js-sdk';
import { describe } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineHomeserverEngineContract } from '../../contract/homeserver-engine.contract';
import { JsSdkHomeserverEngine } from './js-sdk-homeserver-engine';

// Runs the engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

async function register(username: string) {
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
  return (await res.json()) as { user_id: string; access_token: string };
}

describe.skipIf(!baseUrl)('JsSdkHomeserverEngine against Synapse', () => {
  defineHomeserverEngineContract(async () => {
    const me = await register(`hs-${Date.now().toString(36)}`);
    const client = createClient({
      baseUrl: baseUrl as string,
      userId: me.user_id,
      accessToken: me.access_token,
    });
    const engine = Injector.create({
      providers: [
        {
          provide: JS_SDK_CLIENTS,
          useValue: {
            clientFor: (id: string) => (id === me.user_id ? client : null),
          },
        },
        JsSdkHomeserverEngine,
      ],
    }).get(JsSdkHomeserverEngine);
    return { engine, accountId: me.user_id, serverName };
  });
});
