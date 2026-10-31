import { TestBed } from '@angular/core/testing';
import { describe, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineExpressionEngineContract } from '../../contract/expression-engine.contract';
import { expressionSynapseFixture } from '../../contract/media-synapse-fixture';
import { JsSdkExpressionEngine } from './js-sdk-expression-engine';
import {
  baseUrl,
  secret,
  startSession,
  useSynapseSuite,
} from './synapse.spec-harness';

// Runs the expression contract against a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS is set.
describe.skipIf(!baseUrl)('JsSdkExpressionEngine against Synapse', () => {
  useSynapseSuite();

  defineExpressionEngineContract(
    async () => {
      const fixture = await expressionSynapseFixture(baseUrl as string, secret);
      const session = await startSession(fixture.alice);
      const client = TestBed.inject(JS_SDK_CLIENTS).clientFor(session.userId);
      if (!client) throw new Error('No live client for alice');

      return {
        engine: TestBed.inject(JsSdkExpressionEngine),
        alice: session.userId,
        ownRoom: async () => {
          const roomId = await fixture.createOwnRoom();
          await vi.waitFor(
            () => {
              if (client.getRoom(roomId)?.getMyMembership() !== 'join') {
                throw new Error(`Waiting for ${roomId}`);
              }
            },
            { timeout: 30_000, interval: 100 },
          );
          return roomId;
        },
        leave: fixture.leave,
        foreignPackRoom: fixture.foreignPackRoom,
        dispose: () => session.dispose(),
      };
    },
    { settleTimeoutMs: 30_000, testTimeoutMs: 180_000 },
  );
});
