import { TestBed } from '@angular/core/testing';
import { describe } from 'vitest';
import { defineRoomWidgetEngineContract } from '../../contract/room-widget-engine.contract';
import { widgetsSynapseFixture } from '../../contract/widgets-synapse-fixture';
import { JsSdkRoomWidgetEngine } from './js-sdk-room-widget-engine';
import {
  baseUrl,
  secret,
  startSession,
  useSynapseSuite,
} from './synapse.spec-harness';

// Runs the room widget contract against a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS is set.
describe.skipIf(!baseUrl)('JsSdkRoomWidgetEngine against Synapse', () => {
  useSynapseSuite();

  defineRoomWidgetEngineContract(
    async () => {
      const { alice, ...fixture } = await widgetsSynapseFixture(
        baseUrl as string,
        secret,
      );
      const session = await startSession(alice);

      return {
        ...fixture,
        engine: TestBed.inject(JsSdkRoomWidgetEngine),
        alice: session.userId,
        aliceDeviceId: session.deviceId,
        homeserverUrl: session.baseUrl,
        dispose: () => session.dispose(),
      };
    },
    { settleTimeoutMs: 30_000, testTimeoutMs: 180_000 },
  );
});
