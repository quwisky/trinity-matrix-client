import { TestBed } from '@angular/core/testing';
import { describe, vi } from 'vitest';
import { defineRoomAdministrationEngineContract } from '../../contract/room-administration-engine.contract';
import { JsSdkRoomAdministrationEngine } from './js-sdk-room-administration-engine';
import {
  baseUrl,
  cs,
  localpart,
  register,
  room,
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

async function setDisplayName(
  accessToken: string,
  userId: string,
  roomId: string,
  name: string,
): Promise<void> {
  const path = `${room(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`;
  const current = (await cs(accessToken, 'GET', path)) as Record<
    string,
    unknown
  >;
  await cs(accessToken, 'PUT', path, { ...current, displayname: name });
}

// Runs the room administration contract against a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS is set.
describe.skipIf(!baseUrl)(
  'JsSdkRoomAdministrationEngine against Synapse',
  () => {
    useSynapseSuite();

    defineRoomAdministrationEngineContract(
      async () => {
        const [aliceUser, bob, carol] = await Promise.all([
          register(localpart('alice')),
          register(localpart('bob')),
          register(localpart('carol')),
        ]);
        const session = await startSession(aliceUser);
        const join = async (accessToken: string, roomId: string) => {
          await cs(accessToken, 'POST', `${room(roomId)}/join`, {});
        };

        return {
          engine: TestBed.inject(JsSdkRoomAdministrationEngine),
          alice: session.userId,
          bob: bob.userId,
          carol: carol.userId,
          asAlice: {
            join: (roomId) => join(session.accessToken, roomId),
          },
          asBob: {
            createRoom: async (options = {}) =>
              (
                (await cs(bob.accessToken, 'POST', '/createRoom', {
                  preset: 'private_chat',
                  ...(options.roomVersion
                    ? { room_version: options.roomVersion }
                    : {}),
                  ...(options.additionalCreators
                    ? {
                        creation_content: {
                          additional_creators: options.additionalCreators,
                        },
                      }
                    : {}),
                  ...(options.encrypted
                    ? {
                        initial_state: [
                          {
                            type: 'm.room.encryption',
                            state_key: '',
                            content: { algorithm: 'm.megolm.v1.aes-sha2' },
                          },
                        ],
                      }
                    : {}),
                })) as { room_id: string }
              ).room_id,
            invite: async (roomId, userId) => {
              await cs(bob.accessToken, 'POST', `${room(roomId)}/invite`, {
                user_id: userId,
              });
            },
            setPowerLevel: async (roomId, userId, level) => {
              const path = `${room(roomId)}/state/m.room.power_levels/`;
              const levels = (await cs(bob.accessToken, 'GET', path)) as {
                users?: Record<string, number>;
              };
              await cs(bob.accessToken, 'PUT', path, {
                ...levels,
                users: { ...levels.users, [userId]: level },
              });
            },
            setDisplayName: (roomId, name) =>
              setDisplayName(bob.accessToken, bob.userId, roomId, name),
            ban: async (roomId, userId, reason) => {
              await cs(bob.accessToken, 'POST', `${room(roomId)}/ban`, {
                user_id: userId,
                reason,
              });
            },
            sendMessage: async (roomId, body) => {
              const txn = `ra-${Date.now()}-${Math.random().toString(36).slice(2)}`;
              const sent = (await cs(
                bob.accessToken,
                'PUT',
                `${room(roomId)}/send/m.room.message/${txn}`,
                { msgtype: 'm.text', body },
              )) as { event_id: string };
              return sent.event_id;
            },
          },
          asCarol: {
            join: (roomId) => join(carol.accessToken, roomId),
            leave: async (roomId) => {
              await cs(carol.accessToken, 'POST', `${room(roomId)}/leave`, {});
            },
            setDisplayName: (roomId, name) =>
              setDisplayName(carol.accessToken, carol.userId, roomId, name),
          },
          dispose: () => session.dispose(),
        };
      },
      { settleTimeoutMs: 30_000, testTimeoutMs: 180_000 },
    );
  },
);
