import { Injector } from '@angular/core';
import { createClient } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import {
  type StdioTransport,
  registerSynapseUser,
  startTesthostAccount,
  testhostBinaryAvailable,
} from '@trinity/testing';
import { proxyEngine } from '@trinity/util/matrix';
import { defineHomeserverEngineContract } from '../../contract/homeserver-engine.contract';
import type { HomeserverEngine } from '../homeserver-engine';
import { JsSdkHomeserverEngine } from '../js-sdk/js-sdk-homeserver-engine';

// Runs the engine contract against the Rust test host and a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS and TRINITY_ENGINE_TESTHOST are set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'] ?? '';
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

describe.skipIf(!baseUrl || !testhostBinaryAvailable())(
  'Rust HomeserverEngine against Synapse',
  () => {
    let me: Awaited<ReturnType<typeof registerSynapseUser>>;
    let transport: StdioTransport | undefined;
    let engine: HomeserverEngine;
    beforeAll(async () => {
      me = await registerSynapseUser(
        baseUrl,
        secret,
        `hs-rust-${Date.now().toString(36)}`,
      );
      transport = await startTesthostAccount(baseUrl, me);
      engine = proxyEngine<HomeserverEngine>('homeserver', transport);
    }, 60_000);
    afterAll(async () => {
      await transport?.dispose();
    });

    defineHomeserverEngineContract(async () => ({
      engine,
      accountId: me.userId,
      serverName,
    }));

    it('probes the account as the js-sdk adapter does', async () => {
      const client = createClient({
        baseUrl,
        userId: me.userId,
        accessToken: me.accessToken,
      });
      const js = Injector.create({
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

      const [expected, probe] = await Promise.all([
        firstValueFrom(js.probe(me.userId)),
        firstValueFrom(engine.probe(me.userId)),
      ]);

      expect(expected).not.toBeNull();
      expect(probe).toEqual(expected);
    });
  },
);
