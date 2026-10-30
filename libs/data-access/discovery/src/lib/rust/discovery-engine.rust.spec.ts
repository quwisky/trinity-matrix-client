import { afterAll, describe } from 'vitest';
import {
  type StdioTransport,
  startTesthostAccount,
  testhostBinaryAvailable,
} from '@trinity/testing';
import { proxyEngine } from '@trinity/util/matrix';
import { defineDiscoveryEngineContract } from '../../contract/discovery-engine.contract';
import { discoverySynapseFixture } from '../../contract/discovery-synapse-fixture';
import type { DiscoveryEngine } from '../discovery-engine';

// Runs the engine contract against the Rust test host and a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS and TRINITY_ENGINE_TESTHOST are set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

describe.skipIf(!baseUrl || !testhostBinaryAvailable())(
  'Rust DiscoveryEngine against Synapse',
  () => {
    let transport: StdioTransport | undefined;
    afterAll(async () => {
      await transport?.dispose();
    });

    defineDiscoveryEngineContract(async () => {
      const { me, ...fixture } = await discoverySynapseFixture(
        baseUrl as string,
        serverName,
        secret,
      );
      // Started after the fixture, so the first sync already holds the joined room.
      transport = await startTesthostAccount(baseUrl as string, me);
      return {
        engine: proxyEngine<DiscoveryEngine>('discovery', transport),
        accountId: me.userId,
        ...fixture,
      };
    });
  },
);
