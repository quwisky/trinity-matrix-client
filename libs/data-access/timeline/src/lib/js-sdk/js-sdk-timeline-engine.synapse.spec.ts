import { TestBed } from '@angular/core/testing';
import { describe } from 'vitest';
import { defineTimelineEngineContract } from '../../contract/timeline-engine.contract';
import { JsSdkTimelineEngine } from './js-sdk-timeline-engine';
import {
  baseUrl,
  cs,
  localpart,
  register,
  room,
  serverName,
  startSession,
  stubUnencryptedRooms,
  useSynapseSuite,
} from './synapse.spec-harness';

// Runs the timeline engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const SETTLE_TIMEOUT_MS = 30_000;

/** The event `userId`'s `m.read` receipt names in the room, from an initial sync of that room. */
async function receiptIn(
  accessToken: string,
  roomId: string,
  userId: string,
): Promise<string | null> {
  const syncFilter = JSON.stringify({
    presence: { not_types: ['*'] },
    account_data: { not_types: ['*'] },
    room: {
      rooms: [roomId],
      timeline: { limit: 1 },
      state: { lazy_load_members: true },
      ephemeral: { types: ['m.receipt'] },
    },
  });
  const sync = (await cs(
    accessToken,
    'GET',
    `/sync?filter=${encodeURIComponent(syncFilter)}`,
  )) as {
    rooms?: {
      join?: Record<
        string,
        { ephemeral?: { events?: { type: string; content: unknown }[] } }
      >;
    };
  };
  for (const event of sync.rooms?.join?.[roomId]?.ephemeral?.events ?? []) {
    if (event.type !== 'm.receipt') continue;
    for (const [eventId, kinds] of Object.entries(
      event.content as Record<string, Record<string, Record<string, unknown>>>,
    )) {
      if (kinds['m.read']?.[userId]) return eventId;
    }
  }
  return null;
}

describe.skipIf(!baseUrl)('JsSdkTimelineEngine against Synapse', () => {
  useSynapseSuite();

  defineTimelineEngineContract(
    async () => {
      const [aliceUser, bob] = await Promise.all([
        register(localpart('alice')),
        register(localpart('bob')),
      ]);
      const session = await startSession(aliceUser);
      const alice = session.userId;

      return {
        engine: TestBed.inject(JsSdkTimelineEngine),
        alice,
        bob: bob.userId,
        serverName,
        asAlice: {
          join: async (roomId) => {
            await cs(session.accessToken, 'POST', `${room(roomId)}/join`, {});
          },
          fullyRead: async (roomId) => {
            const marker = (await cs(
              session.accessToken,
              'GET',
              `/user/${encodeURIComponent(alice)}${room(roomId)}/account_data/m.fully_read`,
            )) as { event_id?: string } | null;
            return marker?.event_id ?? null;
          },
        },
        asBob: {
          createRoom: async (name) =>
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
                ],
              })) as { room_id: string }
            ).room_id,
          invite: async (roomId, userId) => {
            await cs(bob.accessToken, 'POST', `${room(roomId)}/invite`, {
              user_id: userId,
            });
          },
          send: async (roomId, body) =>
            (
              (await cs(
                bob.accessToken,
                'PUT',
                `${room(roomId)}/send/m.room.message/${localpart('txn')}`,
                { msgtype: 'm.text', body },
              )) as { event_id: string }
            ).event_id,
          sendInThread: async (roomId, rootId, body) =>
            (
              (await cs(
                bob.accessToken,
                'PUT',
                `${room(roomId)}/send/m.room.message/${localpart('txn')}`,
                {
                  msgtype: 'm.text',
                  body,
                  'm.relates_to': {
                    rel_type: 'm.thread',
                    event_id: rootId,
                    is_falling_back: true,
                    'm.in_reply_to': { event_id: rootId },
                  },
                },
              )) as { event_id: string }
            ).event_id,
          react: async (roomId, eventId, key) => {
            await cs(
              bob.accessToken,
              'PUT',
              `${room(roomId)}/send/m.reaction/${localpart('txn')}`,
              {
                'm.relates_to': {
                  rel_type: 'm.annotation',
                  event_id: eventId,
                  key,
                },
              },
            );
          },
          redact: async (roomId, eventId) => {
            await cs(
              bob.accessToken,
              'PUT',
              `${room(roomId)}/redact/${encodeURIComponent(eventId)}/${localpart('txn')}`,
              {},
            );
          },
          edit: async (roomId, eventId, body) => {
            await cs(
              bob.accessToken,
              'PUT',
              `${room(roomId)}/send/m.room.message/${localpart('txn')}`,
              {
                msgtype: 'm.text',
                body: `* ${body}`,
                'm.new_content': { msgtype: 'm.text', body },
                'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
              },
            );
          },
          // The receipt reaches bob's sync asynchronously, so poll until it names an event.
          readReceipt: async (roomId, userId) => {
            const deadline = Date.now() + SETTLE_TIMEOUT_MS;
            for (;;) {
              const eventId = await receiptIn(bob.accessToken, roomId, userId);
              if (eventId || Date.now() > deadline) return eventId;
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          },
        },
        // A crypto store that knows the contract's rooms are unencrypted, as the real one would.
        knownUnencrypted: stubUnencryptedRooms,
        dispose: () => session.dispose(),
      };
    },
    { settleTimeoutMs: SETTLE_TIMEOUT_MS, testTimeoutMs: 180_000 },
  );
});
