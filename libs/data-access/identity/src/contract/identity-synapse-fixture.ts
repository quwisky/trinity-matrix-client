import { registerSynapseUser, synapseRequest } from '@trinity/testing';
import type { IgnoredUserInfo } from '../lib/identity-engine';

type SynapseUser = Awaited<ReturnType<typeof registerSynapseUser>>;

export interface IdentitySynapseFixture {
  readonly alice: SynapseUser;
  readonly bob: SynapseUser;
  readonly unknownUser: string;
  readonly knownUser: IgnoredUserInfo;
  readonly avatars: readonly [string, string];
}

/**
 * The users the identity contract drives, on a live Synapse: alice and bob share a room with carol,
 * whose profile is the contract's `knownUser`. No client is started and nothing is synced, so each
 * spec signs alice and bob in to its engine afterwards.
 */
export async function identitySynapseFixture(
  baseUrl: string,
  serverName: string,
  secret: string,
): Promise<IdentitySynapseFixture> {
  const unique = Date.now().toString(36);
  const [alice, bob, carol] = await Promise.all([
    registerSynapseUser(baseUrl, secret, `id-a-${unique}`),
    registerSynapseUser(baseUrl, secret, `id-b-${unique}`),
    registerSynapseUser(baseUrl, secret, `id-c-${unique}`),
  ]);
  const knownUser: IgnoredUserInfo = {
    userId: carol.userId,
    displayName: `Carol ${unique}`,
    avatarMxc: `mxc://${serverName}/id-c-${unique}`,
  };
  const profile = `/profile/${encodeURIComponent(carol.userId)}`;
  await synapseRequest(
    baseUrl,
    carol.accessToken,
    'PUT',
    `${profile}/displayname`,
    { displayname: knownUser.displayName },
  );
  await synapseRequest(
    baseUrl,
    carol.accessToken,
    'PUT',
    `${profile}/avatar_url`,
    { avatar_url: knownUser.avatarMxc },
  );
  // A shared room: Synapse sends presence only to users who share one. Carol's join
  // carries her profile into alice's first sync.
  const { room_id: roomId } = await synapseRequest<{ room_id: string }>(
    baseUrl,
    alice.accessToken,
    'POST',
    '/createRoom',
    { invite: [bob.userId, carol.userId] },
  );
  await Promise.all(
    [bob, carol].map((user) =>
      synapseRequest(
        baseUrl,
        user.accessToken,
        'POST',
        `/rooms/${encodeURIComponent(roomId)}/join`,
        {},
      ),
    ),
  );
  return {
    alice,
    bob,
    unknownUser: `@id-ghost-${unique}:${serverName}`,
    knownUser,
    avatars: [
      `mxc://${serverName}/id-a-${unique}`,
      `mxc://${serverName}/id-b-${unique}`,
    ],
  };
}
