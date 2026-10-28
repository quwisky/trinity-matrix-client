import { TestBed } from '@angular/core/testing';
import { describe, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineExpressionEngineContract } from '../../contract/expression-engine.contract';
import { IMAGE_PACK_EVENT_TYPE } from '../image-pack.model';
import { JsSdkExpressionEngine } from './js-sdk-expression-engine';
import {
  baseUrl,
  cs,
  localpart,
  register,
  startSession,
  useSynapseSuite,
} from './synapse.spec-harness';

// jsdom serves no crypto .wasm and has no IndexedDB (the sync store falls back to memory).
vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
});

// Runs the expression contract against a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS is set.
describe.skipIf(!baseUrl)('JsSdkExpressionEngine against Synapse', () => {
  useSynapseSuite();

  defineExpressionEngineContract(
    async () => {
      const session = await startSession(await register(localpart('alice')));
      const client = TestBed.inject(JS_SDK_CLIENTS).clientFor(session.userId);
      if (!client) throw new Error('No live client for alice');
      const bob = await register(localpart('bob'));
      const server = bob.userId.slice(bob.userId.indexOf(':') + 1);

      return {
        engine: TestBed.inject(JsSdkExpressionEngine),
        alice: session.userId,
        ownRoom: async () => {
          const { room_id } = (await cs(
            session.accessToken,
            'POST',
            '/createRoom',
            { preset: 'private_chat' },
          )) as { room_id: string };
          await vi.waitFor(
            () => {
              if (client.getRoom(room_id)?.getMyMembership() !== 'join') {
                throw new Error(`Waiting for ${room_id}`);
              }
            },
            { timeout: 30_000, interval: 100 },
          );
          return room_id;
        },
        leave: async (roomId) => {
          await cs(
            session.accessToken,
            'POST',
            `/rooms/${encodeURIComponent(roomId)}/leave`,
            {},
          );
        },
        foreignPackRoom: async (name, pack) => {
          const aliasLocal = localpart('pack');
          const { room_id } = (await cs(
            bob.accessToken,
            'POST',
            '/createRoom',
            {
              preset: 'public_chat',
              name,
              room_alias_name: aliasLocal,
              initial_state: [
                { type: IMAGE_PACK_EVENT_TYPE, state_key: '', content: pack },
                {
                  type: 'm.room.history_visibility',
                  state_key: '',
                  content: { history_visibility: 'world_readable' },
                },
              ],
            },
          )) as { room_id: string };
          return { roomId: room_id, alias: `#${aliasLocal}:${server}` };
        },
        dispose: () => session.dispose(),
      };
    },
    { settleTimeoutMs: 30_000, testTimeoutMs: 180_000 },
  );
});
