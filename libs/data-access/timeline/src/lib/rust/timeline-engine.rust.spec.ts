import { beforeAll, describe } from 'vitest';
import {
  startTesthostAccount,
  testhostBinaryAvailable,
  waitForSynapseBackgroundUpdates,
} from '@trinity/testing';
import { proxyEngine } from '@trinity/util/matrix';
import { defineTimelineEngineContract } from '../../contract/timeline-engine.contract';
import { timelineSynapseFixture } from '../../contract/timeline-synapse-fixture';
import type { TimelineEngine } from '../timeline-engine';

// Runs the engine contract against the Rust test host and a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS and TRINITY_ENGINE_TESTHOST are set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

describe.skipIf(!baseUrl || !testhostBinaryAvailable())(
  'Rust TimelineEngine against Synapse',
  () => {
    beforeAll(
      () => waitForSynapseBackgroundUpdates(baseUrl as string, secret),
      120_000,
    );

    defineTimelineEngineContract(
      async () => {
        const { alice, ...fixture } = await timelineSynapseFixture(
          baseUrl as string,
          serverName,
          secret,
        );
        const transport = await startTesthostAccount(baseUrl as string, alice);
        return {
          engine: proxyEngine<TimelineEngine>('timeline', transport),
          alice: alice.userId,
          ...fixture,
          dispose: () => transport.dispose(),
        };
      },
      { settleTimeoutMs: 30_000, testTimeoutMs: 180_000 },
    );
  },
);
