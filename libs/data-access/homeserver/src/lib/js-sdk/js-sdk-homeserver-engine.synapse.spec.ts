import { Injector } from '@angular/core';
import { createClient } from 'matrix-js-sdk';
import { describe } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { registerSynapseUser } from '@trinity/testing';
import { defineHomeserverEngineContract } from '../../contract/homeserver-engine.contract';
import { JsSdkHomeserverEngine } from './js-sdk-homeserver-engine';

// Runs the engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

describe.skipIf(!baseUrl)('JsSdkHomeserverEngine against Synapse', () => {
  defineHomeserverEngineContract(async () => {
    const me = await registerSynapseUser(
      baseUrl as string,
      secret,
      `hs-${Date.now().toString(36)}`,
    );
    const client = createClient({
      baseUrl: baseUrl as string,
      userId: me.userId,
      accessToken: me.accessToken,
    });
    const engine = Injector.create({
      providers: [
        {
          provide: JS_SDK_CLIENTS,
          useValue: {
            clientFor: (id: string) => (id === me.userId ? client : null),
          },
        },
        JsSdkHomeserverEngine,
      ],
    }).get(JsSdkHomeserverEngine);
    return { engine, accountId: me.userId, serverName };
  });
});
