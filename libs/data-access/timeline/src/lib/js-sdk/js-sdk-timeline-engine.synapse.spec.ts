import { TestBed } from '@angular/core/testing';
import { describe } from 'vitest';
import { defineTimelineEngineContract } from '../../contract/timeline-engine.contract';
import { JsSdkTimelineEngine } from './js-sdk-timeline-engine';
import { timelineSynapseFixture } from '../../contract/timeline-synapse-fixture';
import {
  baseUrl,
  secret,
  serverName,
  startSession,
  stubUnencryptedRooms,
  useSynapseSuite,
} from './synapse.spec-harness';

// Runs the timeline engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const SETTLE_TIMEOUT_MS = 30_000;

describe.skipIf(!baseUrl)('JsSdkTimelineEngine against Synapse', () => {
  useSynapseSuite();

  defineTimelineEngineContract(
    async () => {
      const { alice: aliceUser, ...fixture } = await timelineSynapseFixture(
        baseUrl as string,
        serverName,
        secret,
      );
      const session = await startSession(aliceUser);

      return {
        engine: TestBed.inject(JsSdkTimelineEngine),
        ...fixture,
        alice: session.userId,
        // A crypto store that knows the contract's rooms are unencrypted, as the real one would.
        knownUnencrypted: stubUnencryptedRooms,
        dispose: () => session.dispose(),
      };
    },
    { settleTimeoutMs: SETTLE_TIMEOUT_MS, testTimeoutMs: 180_000 },
  );
});
