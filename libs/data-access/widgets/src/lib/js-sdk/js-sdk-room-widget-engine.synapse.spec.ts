import { TestBed } from '@angular/core/testing';
import { describe } from 'vitest';
import { defineRoomWidgetEngineContract } from '../../contract/room-widget-engine.contract';
import { WIDGET_EVENT_TYPE } from '../widget.model';
import { JsSdkRoomWidgetEngine } from './js-sdk-room-widget-engine';
import {
  baseUrl,
  cs,
  localpart,
  register,
  room,
  startSession,
  useSynapseSuite,
} from './synapse.spec-harness';

// Runs the room widget contract against a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS is set.
describe.skipIf(!baseUrl)('JsSdkRoomWidgetEngine against Synapse', () => {
  useSynapseSuite();

  defineRoomWidgetEngineContract(
    async () => {
      const [aliceUser, bob] = await Promise.all([
        register(localpart('alice')),
        register(localpart('bob')),
      ]);
      const session = await startSession(aliceUser);

      return {
        engine: TestBed.inject(JsSdkRoomWidgetEngine),
        alice: session.userId,
        bob: bob.userId,
        asAlice: {
          join: async (roomId) => {
            await cs(session.accessToken, 'POST', `${room(roomId)}/join`, {});
          },
          leave: async (roomId) => {
            await cs(session.accessToken, 'POST', `${room(roomId)}/leave`, {});
          },
        },
        asBob: {
          createRoom: async (name) =>
            (
              (await cs(bob.accessToken, 'POST', '/createRoom', {
                name,
                preset: 'private_chat',
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
          putWidget: async (roomId, stateKey, content) => {
            const { event_id } = (await cs(
              bob.accessToken,
              'PUT',
              `${room(roomId)}/state/${WIDGET_EVENT_TYPE}/${encodeURIComponent(stateKey)}`,
              content,
            )) as { event_id: string };
            return event_id;
          },
        },
        dispose: () => session.dispose(),
      };
    },
    { settleTimeoutMs: 30_000, testTimeoutMs: 180_000 },
  );
});
