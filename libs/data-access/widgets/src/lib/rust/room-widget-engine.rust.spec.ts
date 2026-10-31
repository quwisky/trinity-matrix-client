import { afterAll, describe } from 'vitest';
import {
  type StdioTransport,
  startTesthostAccount,
  testhostBinaryAvailable,
} from '@trinity/testing';
import { proxyEngine } from '@trinity/util/matrix';
import { defineRoomWidgetEngineContract } from '../../contract/room-widget-engine.contract';
import { widgetsSynapseFixture } from '../../contract/widgets-synapse-fixture';
import type { RoomWidgetEngine } from '../room-widget-engine';

// Runs the engine contract against the Rust test host and a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS and TRINITY_ENGINE_TESTHOST are set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';
const SETTLE_MS = 30_000;

describe.skipIf(!baseUrl || !testhostBinaryAvailable())(
  'Rust RoomWidgetEngine against Synapse',
  () => {
    const transports: StdioTransport[] = [];
    afterAll(async () => {
      await Promise.all(transports.map((t) => t.dispose()));
    });

    defineRoomWidgetEngineContract(
      async () => {
        const { alice, ...fixture } = await widgetsSynapseFixture(
          baseUrl as string,
          secret,
        );
        const transport = await startTesthostAccount(baseUrl as string, alice);
        transports.push(transport);
        return {
          ...fixture,
          engine: proxyEngine<RoomWidgetEngine>('roomWidget', transport),
          alice: alice.userId,
          aliceDeviceId: alice.deviceId,
          homeserverUrl: baseUrl as string,
          dispose: () => transport.dispose(),
        };
      },
      { settleTimeoutMs: SETTLE_MS, testTimeoutMs: 180_000 },
    );
  },
);
