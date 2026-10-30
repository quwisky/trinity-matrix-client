import { registerSynapseUser, synapseRequest } from '@trinity/testing';
import type { RoomListContractSetup } from './room-list-engine.contract';

type SynapseUser = Awaited<ReturnType<typeof registerSynapseUser>>;

/** MSC4380 through its unstable flags or spec v1.18 and later, as `/versions` reports it. */
async function advertisesInviteBlocking(baseUrl: string): Promise<boolean> {
  const res = await fetch(`${baseUrl}/_matrix/client/versions`);
  if (!res.ok) throw new Error(`Synapse /versions failed: ${res.status}`);
  const { versions = [], unstable_features = {} } = (await res.json()) as {
    versions?: string[];
    unstable_features?: Record<string, boolean>;
  };
  return (
    unstable_features['org.matrix.msc4380'] === true ||
    unstable_features['org.matrix.msc4380.stable'] === true ||
    versions.some((v) => Number(/^v1\.(\d+)$/.exec(v)?.[1]) >= 18)
  );
}

const room = (roomId: string) => `/rooms/${encodeURIComponent(roomId)}`;

let sequence = 0;

function localpart(role: string): string {
  sequence += 1;
  return `rl-${role}-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Alice (registered with a device, signed in to no engine yet), bob, and the HTTP helpers the room list
 * contract drives, for any engine. Call `waitForSynapseBackgroundUpdates` once before the first fixture.
 */
export async function roomListSynapseFixture(
  baseUrl: string,
  serverName: string,
  secret: string,
): Promise<
  Omit<RoomListContractSetup, 'engine' | 'alice' | 'dispose'> & {
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
    serverName,
    serverBlocksInvites: await advertisesInviteBlocking(baseUrl),
    asAlice: {
      publishAlias: async (roomId, name) => {
        const alias = `#${name}:${serverName}`;
        await synapseRequest(
          baseUrl,
          alice.accessToken,
          'PUT',
          `/directory/room/${encodeURIComponent(alias)}`,
          { room_id: roomId },
        );
        return alias;
      },
      join: async (roomId) => {
        await synapseRequest(
          baseUrl,
          alice.accessToken,
          'POST',
          `${room(roomId)}/join`,
          {},
        );
      },
      spaceParents: async (roomId) => {
        const state = await synapseRequest<
          { type: string; state_key: string; content: object }[]
        >(baseUrl, alice.accessToken, 'GET', `${room(roomId)}/state`);
        return state
          .filter(
            (e) =>
              e.type === 'm.space.parent' && Object.keys(e.content).length > 0,
          )
          .map((e) => e.state_key);
      },
    },
    asBob: {
      createRoom: async (name, options) =>
        (
          await synapseRequest<{ room_id: string }>(
            baseUrl,
            bob.accessToken,
            'POST',
            '/createRoom',
            {
              name,
              ...(options?.historyVisibility && {
                initial_state: [
                  {
                    type: 'm.room.history_visibility',
                    state_key: '',
                    content: {
                      history_visibility: options.historyVisibility,
                    },
                  },
                ],
              }),
            },
          )
        ).room_id,
      createPublicRoom: async (name, aliasLocalpart) => {
        const { room_id } = await synapseRequest<{ room_id: string }>(
          baseUrl,
          bob.accessToken,
          'POST',
          '/createRoom',
          { name, preset: 'public_chat', room_alias_name: aliasLocalpart },
        );
        return {
          roomId: room_id,
          alias: `#${aliasLocalpart}:${serverName}`,
        };
      },
      join: async (roomId) => {
        await synapseRequest(
          baseUrl,
          bob.accessToken,
          'POST',
          `${room(roomId)}/join`,
          {},
        );
      },
      // The invite endpoint takes no is_direct; the member event carries it.
      invite: async (roomId, userId, options) => {
        await synapseRequest(
          baseUrl,
          bob.accessToken,
          'PUT',
          `${room(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`,
          {
            membership: 'invite',
            ...(options?.isDirect ? { is_direct: true } : {}),
          },
        );
      },
      sendTyping: async (roomId) => {
        await synapseRequest(
          baseUrl,
          bob.accessToken,
          'PUT',
          `${room(roomId)}/typing/${encodeURIComponent(bob.userId)}`,
          { typing: true, timeout: 30_000 },
        );
      },
      sendMessage: async (roomId, body) => {
        await synapseRequest(
          baseUrl,
          bob.accessToken,
          'PUT',
          `${room(roomId)}/send/m.room.message/${localpart('txn')}`,
          { msgtype: 'm.text', body },
        );
      },
    },
  };
}
