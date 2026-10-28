import { TestBed } from '@angular/core/testing';
import { describe, vi } from 'vitest';
import { defineConversationContentEngineContract } from '../../contract/conversation-content-engine.contract';
import { JsSdkConversationContentEngine } from './js-sdk-conversation-content-engine';
import {
  baseUrl,
  cs,
  localpart,
  register,
  room,
  startSession,
  stubUnencryptedRooms,
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

// Runs the conversation content contract against a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS is set.
const SETTLE_TIMEOUT_MS = 30_000;
// The harness's Open Graph page, as Synapse reaches it (see the link-preview journey):
// 127.0.0.1 natively, one shared loopback in a network container, else compose DNS.
const OG_PAGE =
  process.env['TRINITY_E2E_HOMESERVER_RUNTIME'] === 'native'
    ? 'http://127.0.0.1:8080/og'
    : process.env['TRINITY_E2E_NETWORK_CONTAINER']
      ? 'http://localhost:8080/og'
      : 'http://caddy:8080/og';

async function send(
  accessToken: string,
  roomId: string,
  content: Record<string, unknown>,
): Promise<string> {
  const { event_id } = (await cs(
    accessToken,
    'PUT',
    `${room(roomId)}/send/m.room.message/${localpart('txn')}`,
    content,
  )) as { event_id: string };
  return event_id;
}

const text = (body: string) => ({ msgtype: 'm.text', body });

const edit = (eventId: string, body: string) => ({
  msgtype: 'm.text',
  body: `* ${body}`,
  'm.new_content': text(body),
  'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
});

describe.skipIf(!baseUrl)(
  'JsSdkConversationContentEngine against Synapse',
  () => {
    useSynapseSuite();

    defineConversationContentEngineContract(
      async () => {
        const [aliceUser, bob] = await Promise.all([
          register(localpart('alice')),
          register(localpart('bob')),
        ]);
        const session = await startSession(aliceUser);
        // Crypto is stubbed: the room's state alone says whether it is encrypted.
        const restoreCrypto = stubUnencryptedRooms();

        return {
          engine: TestBed.inject(JsSdkConversationContentEngine),
          alice: session.userId,
          bob: bob.userId,
          previewableUrl: OG_PAGE,
          asAlice: {
            join: async (roomId) => {
              await cs(session.accessToken, 'POST', `${room(roomId)}/join`, {});
            },
            send: (roomId, body) =>
              send(session.accessToken, roomId, text(body)),
            edit: (roomId, eventId, body) =>
              send(session.accessToken, roomId, edit(eventId, body)),
          },
          asBob: {
            createRoom: async (name, options = {}) =>
              (
                (await cs(bob.accessToken, 'POST', '/createRoom', {
                  name,
                  preset: 'private_chat',
                  initial_state: [
                    {
                      type: 'm.room.history_visibility',
                      state_key: '',
                      content: { history_visibility: 'shared' },
                    },
                    ...(options.encrypted
                      ? [
                          {
                            type: 'm.room.encryption',
                            state_key: '',
                            content: { algorithm: 'm.megolm.v1.aes-sha2' },
                          },
                        ]
                      : []),
                  ],
                })) as { room_id: string }
              ).room_id,
            invite: async (roomId, userId) => {
              await cs(bob.accessToken, 'POST', `${room(roomId)}/invite`, {
                user_id: userId,
              });
            },
            promote: async (roomId, userId) => {
              const path = `${room(roomId)}/state/m.room.power_levels/`;
              const levels = (await cs(bob.accessToken, 'GET', path)) as {
                users?: Record<string, number>;
              };
              await cs(bob.accessToken, 'PUT', path, {
                ...levels,
                users: { ...levels.users, [userId]: 100 },
              });
            },
            send: (roomId, body) => send(bob.accessToken, roomId, text(body)),
            edit: (roomId, eventId, body) =>
              send(bob.accessToken, roomId, edit(eventId, body)),
            setPinned: async (roomId, eventIds) => {
              await cs(
                bob.accessToken,
                'PUT',
                `${room(roomId)}/state/m.room.pinned_events/`,
                { pinned: eventIds },
              );
            },
          },
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
