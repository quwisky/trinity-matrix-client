import { TestBed } from '@angular/core/testing';
import { describe } from 'vitest';
import { defineConversationContentEngineContract } from '../../contract/conversation-content-engine.contract';
import { JsSdkConversationContentEngine } from './js-sdk-conversation-content-engine';
import { conversationContentSynapseFixture } from '../../contract/timeline-synapse-fixture';
import {
  baseUrl,
  secret,
  serverName,
  startSession,
  stubUnencryptedRooms,
  useSynapseSuite,
} from './synapse.spec-harness';

// Runs the conversation content contract against a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS is set.
const SETTLE_TIMEOUT_MS = 30_000;
describe.skipIf(!baseUrl)(
  'JsSdkConversationContentEngine against Synapse',
  () => {
    useSynapseSuite();

    defineConversationContentEngineContract(
      async () => {
        const { alice: aliceUser, ...fixture } =
          await conversationContentSynapseFixture(
            baseUrl as string,
            serverName,
            secret,
          );
        const session = await startSession(aliceUser);
        // Crypto is stubbed: the room's state alone says whether it is encrypted.
        const restoreCrypto = stubUnencryptedRooms();

        return {
          engine: TestBed.inject(JsSdkConversationContentEngine),
          ...fixture,
          alice: session.userId,
          dispose: async () => {
            restoreCrypto();
            await session.dispose();
          },
        };
      },
      { settleTimeoutMs: SETTLE_TIMEOUT_MS, testTimeoutMs: 180_000 },
    );
  },
);
