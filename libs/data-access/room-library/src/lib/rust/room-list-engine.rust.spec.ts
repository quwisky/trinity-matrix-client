import { beforeAll, describe } from 'vitest';
import {
  startTesthostAccount,
  testhostBinaryAvailable,
  waitForSynapseBackgroundUpdates,
} from '@trinity/testing';
import { proxyEngine } from '@trinity/util/matrix';
import { defineRoomListEngineContract } from '../../contract/room-list-engine.contract';
import { roomListSynapseFixture } from '../../contract/room-list-synapse-fixture';
import type { RoomListEngine } from '../room-list-engine';

// Runs the engine contract against the Rust test host and a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS and TRINITY_ENGINE_TESTHOST are set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

describe.skipIf(!baseUrl || !testhostBinaryAvailable())(
  'Rust RoomListEngine against Synapse',
  () => {
    beforeAll(
      () => waitForSynapseBackgroundUpdates(baseUrl as string, secret),
      120_000,
    );

    defineRoomListEngineContract(
      async () => {
        const { alice, ...fixture } = await roomListSynapseFixture(
          baseUrl as string,
          serverName,
          secret,
        );
        const transport = await startTesthostAccount(baseUrl as string, alice);
        return {
          engine: proxyEngine<RoomListEngine>('roomList', transport),
          alice: alice.userId,
          ...fixture,
          dispose: () => transport.dispose(),
        };
      },
      { settleTimeoutMs: 30_000, testTimeoutMs: 180_000 },
    );
  },
);
