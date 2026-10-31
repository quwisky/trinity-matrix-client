import { type Observable, filter, firstValueFrom, scan, timeout } from 'rxjs';
import { afterAll, describe } from 'vitest';
import {
  type StdioTransport,
  startTesthostAccount,
  testhostBinaryAvailable,
} from '@trinity/testing';
import {
  type VectorDiff,
  applyVectorDiffs,
  proxyEngine,
} from '@trinity/util/matrix';
import { defineExpressionEngineContract } from '../../contract/expression-engine.contract';
import { expressionSynapseFixture } from '../../contract/media-synapse-fixture';
import type { ExpressionEngine } from '../expression-engine';

// Runs the engine contract against the Rust test host and a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS and TRINITY_ENGINE_TESTHOST are set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';
const SETTLE_MS = 30_000;

/** The one field of a room-list row this spec reads; the room-list engine is another library's. */
interface RoomRow {
  readonly roomId: string;
}
interface RoomListRows {
  rooms(accountId: string): Observable<readonly VectorDiff<RoomRow>[]>;
}

describe.skipIf(!baseUrl || !testhostBinaryAvailable())(
  'Rust ExpressionEngine against Synapse',
  () => {
    const transports: StdioTransport[] = [];
    afterAll(async () => {
      await Promise.all(transports.map((t) => t.dispose()));
    });

    defineExpressionEngineContract(
      async () => {
        const fixture = await expressionSynapseFixture(
          baseUrl as string,
          secret,
        );
        const transport = await startTesthostAccount(
          baseUrl as string,
          fixture.alice,
        );
        transports.push(transport);
        const alice = fixture.alice.userId;
        const rows = proxyEngine<RoomListRows>('roomList', transport);
        const waitForRoomRow = (roomId: string): Promise<unknown> =>
          firstValueFrom(
            rows.rooms(alice).pipe(
              scan(
                (list: readonly RoomRow[], batch) =>
                  applyVectorDiffs(list, batch),
                [],
              ),
              filter((list) => list.some((row) => row.roomId === roomId)),
              timeout(SETTLE_MS),
            ),
          );
        return {
          engine: proxyEngine<ExpressionEngine>('expression', transport),
          alice,
          ownRoom: async () => {
            const roomId = await fixture.createOwnRoom();
            await waitForRoomRow(roomId);
            return roomId;
          },
          leave: fixture.leave,
          foreignPackRoom: fixture.foreignPackRoom,
          dispose: () => transport.dispose(),
        };
      },
      { settleTimeoutMs: SETTLE_MS, testTimeoutMs: 180_000 },
    );
  },
);
