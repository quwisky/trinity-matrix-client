import { registerSynapseUser, synapseRequest } from '@trinity/testing';
import { WIDGET_EVENT_TYPE } from '../lib/widget.model';
import type { RoomWidgetContractSetup } from './room-widget-engine.contract';

type SynapseUser = Awaited<ReturnType<typeof registerSynapseUser>>;

const room = (roomId: string) => `/rooms/${encodeURIComponent(roomId)}`;

let sequence = 0;

function localpart(role: string): string {
  sequence += 1;
  return `wg-${role}-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Alice (registered with a device, signed in to no engine yet), bob, and the HTTP helpers the widget contract drives. */
export async function widgetsSynapseFixture(
  baseUrl: string,
  secret: string,
): Promise<
  Omit<RoomWidgetContractSetup, 'engine' | 'alice' | 'dispose'> & {
    readonly alice: SynapseUser;
  }
> {
  const [alice, bob] = await Promise.all([
    registerSynapseUser(baseUrl, secret, localpart('alice')),
    registerSynapseUser(baseUrl, secret, localpart('bob')),
  ]);
  return {
    alice,
    bob: bob.userId,
    asAlice: {
      join: async (roomId) => {
        await synapseRequest(
          baseUrl,
          alice.accessToken,
          'POST',
          `${room(roomId)}/join`,
          {},
        );
      },
      leave: async (roomId) => {
        await synapseRequest(
          baseUrl,
          alice.accessToken,
          'POST',
          `${room(roomId)}/leave`,
          {},
        );
      },
    },
    asBob: {
      createRoom: async (name) =>
        (
          await synapseRequest<{ room_id: string }>(
            baseUrl,
            bob.accessToken,
            'POST',
            '/createRoom',
            { name, preset: 'private_chat' },
          )
        ).room_id,
      invite: async (roomId, userId) => {
        await synapseRequest(
          baseUrl,
          bob.accessToken,
          'POST',
          `${room(roomId)}/invite`,
          { user_id: userId },
        );
      },
      setPowerLevel: async (roomId, userId, level) => {
        const path = `${room(roomId)}/state/m.room.power_levels/`;
        const levels = await synapseRequest<{ users?: Record<string, number> }>(
          baseUrl,
          bob.accessToken,
          'GET',
          path,
        );
        await synapseRequest(baseUrl, bob.accessToken, 'PUT', path, {
          ...levels,
          users: { ...levels.users, [userId]: level },
        });
      },
      putWidget: async (roomId, stateKey, content) =>
        (
          await synapseRequest<{ event_id: string }>(
            baseUrl,
            bob.accessToken,
            'PUT',
            `${room(roomId)}/state/${WIDGET_EVENT_TYPE}/${encodeURIComponent(stateKey)}`,
            content,
          )
        ).event_id,
    },
  };
}
