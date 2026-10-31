import { registerSynapseUser, synapseRequest } from '@trinity/testing';
import type { RoomAdministrationContractSetup } from './room-administration-engine.contract';

type SynapseUser = Awaited<ReturnType<typeof registerSynapseUser>>;

const room = (roomId: string) => `/rooms/${encodeURIComponent(roomId)}`;

let sequence = 0;

function localpart(role: string): string {
  sequence += 1;
  return `ra-${role}-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 6)}`;
}

async function setDisplayName(
  baseUrl: string,
  user: SynapseUser,
  roomId: string,
  name: string,
): Promise<void> {
  const path = `${room(roomId)}/state/m.room.member/${encodeURIComponent(user.userId)}`;
  const current = await synapseRequest<Record<string, unknown>>(
    baseUrl,
    user.accessToken,
    'GET',
    path,
  );
  await synapseRequest(baseUrl, user.accessToken, 'PUT', path, {
    ...current,
    displayname: name,
  });
}

/** Alice (registered with a device, signed in to no engine yet), bob, carol, and the HTTP helpers the room administration contract drives. */
export async function roomAdministrationSynapseFixture(
  baseUrl: string,
  secret: string,
): Promise<
  Omit<RoomAdministrationContractSetup, 'engine' | 'alice' | 'dispose'> & {
    readonly alice: SynapseUser;
  }
> {
  const [alice, bob, carol] = await Promise.all([
    registerSynapseUser(baseUrl, secret, localpart('alice')),
    registerSynapseUser(baseUrl, secret, localpart('bob')),
    registerSynapseUser(baseUrl, secret, localpart('carol')),
  ]);
  const join = async (user: SynapseUser, roomId: string) => {
    await synapseRequest(
      baseUrl,
      user.accessToken,
      'POST',
      `${room(roomId)}/join`,
      {},
    );
  };
  return {
    alice,
    bob: bob.userId,
    carol: carol.userId,
    asAlice: { join: (roomId) => join(alice, roomId) },
    asBob: {
      createRoom: async (options = {}) =>
        (
          await synapseRequest<{ room_id: string }>(
            baseUrl,
            bob.accessToken,
            'POST',
            '/createRoom',
            {
              preset: 'private_chat',
              room_version: options.roomVersion ?? '11',
              creation_content: {
                ...(options.additionalCreators
                  ? { additional_creators: options.additionalCreators }
                  : {}),
                ...(options.space ? { type: 'm.space' } : {}),
              },
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
            },
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
      setDisplayName: (roomId, name) =>
        setDisplayName(baseUrl, bob, roomId, name),
      ban: async (roomId, userId, reason) => {
        await synapseRequest(
          baseUrl,
          bob.accessToken,
          'POST',
          `${room(roomId)}/ban`,
          { user_id: userId, reason },
        );
      },
      setState: async (roomId, type, content, stateKey = '') => {
        await synapseRequest(
          baseUrl,
          bob.accessToken,
          'PUT',
          `${room(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
          content,
        );
      },
      sendMessage: async (roomId, body) => {
        const txn = localpart('txn');
        const sent = await synapseRequest<{ event_id: string }>(
          baseUrl,
          bob.accessToken,
          'PUT',
          `${room(roomId)}/send/m.room.message/${txn}`,
          { msgtype: 'm.text', body },
        );
        return sent.event_id;
      },
    },
    asCarol: {
      join: (roomId) => join(carol, roomId),
      leave: async (roomId) => {
        await synapseRequest(
          baseUrl,
          carol.accessToken,
          'POST',
          `${room(roomId)}/leave`,
          {},
        );
      },
      setDisplayName: (roomId, name) =>
        setDisplayName(baseUrl, carol, roomId, name),
    },
  };
}
