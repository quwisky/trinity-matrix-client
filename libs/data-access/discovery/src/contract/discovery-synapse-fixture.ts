import { registerSynapseUser } from '@trinity/testing';

type SynapseUser = Awaited<ReturnType<typeof registerSynapseUser>>;

/** A Client-Server API call as `token`, through plain HTTP so any engine can use the fixture. */
async function api<T>(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl}/_matrix/client/v3${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

// A fresh Synapse rebuilds its user directory in a background update and drops users
// registered meanwhile, so the contract users are only created once it has finished.
async function waitForBackgroundUpdates(
  baseUrl: string,
  secret: string,
): Promise<void> {
  const admin = await registerSynapseUser(
    baseUrl,
    secret,
    `admin-${Date.now().toString(36)}`,
    true,
  );
  for (let i = 0; i < 240; i++) {
    const res = await fetch(
      `${baseUrl}/_synapse/admin/v1/background_updates/status`,
      { headers: { authorization: `Bearer ${admin.accessToken}` } },
    );
    if (!res.ok)
      throw new Error(`Synapse background update status failed: ${res.status}`);
    const { current_updates } = (await res.json()) as {
      current_updates: Record<string, unknown>;
    };
    if (Object.keys(current_updates).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Synapse background updates did not finish');
}

/**
 * The users, rooms and directory entries the discovery contract reads, on a live Synapse.
 * `me` has created and joined `joinedRoom` but has not synced: each spec signs `me` in to
 * its engine afterwards, so the engine's first sync already holds the room.
 */
export async function discoverySynapseFixture(
  baseUrl: string,
  serverName: string,
  secret: string,
): Promise<{
  me: SynapseUser;
  domain: string;
  publicRoom: { roomId: string; name: string; alias: string };
  unjoinedRoom: { roomId: string; name: string; alias: string };
  joinedRoom: { roomId: string; name: string };
  knockRoom: { roomId: string };
  otherUser: { userId: string; displayName: string };
}> {
  await waitForBackgroundUpdates(baseUrl, secret);
  const unique = Date.now().toString(36);
  const [me, other] = await Promise.all([
    registerSynapseUser(baseUrl, secret, `disc-a-${unique}`),
    registerSynapseUser(baseUrl, secret, `disc-b-${unique}`),
  ]);
  const createRoom = async (
    user: SynapseUser,
    body: Record<string, unknown>,
  ): Promise<string> =>
    (
      await api<{ room_id: string }>(
        baseUrl,
        user.accessToken,
        'POST',
        '/createRoom',
        body,
      )
    ).room_id;

  const displayName = `Other ${unique}`;
  const name = `Room ${unique}`;
  await api(
    baseUrl,
    other.accessToken,
    'PUT',
    `/profile/${encodeURIComponent(other.userId)}/displayname`,
    { displayname: displayName },
  );
  const roomId = await createRoom(other, {
    visibility: 'public',
    preset: 'public_chat',
    name,
    room_alias_name: `room-${unique}`,
  });
  const unjoinedName = `Plaza ${unique}`;
  const unjoinedId = await createRoom(other, {
    visibility: 'public',
    preset: 'public_chat',
    name: unjoinedName,
    room_alias_name: `plaza-${unique}`,
  });
  const knockId = await createRoom(other, {
    name: `Door ${unique}`,
    initial_state: [
      {
        type: 'm.room.join_rules',
        state_key: '',
        content: { join_rule: 'knock' },
      },
    ],
  });
  // Public, so no encryption: only the synced room can then say it is unencrypted.
  const joinedName = `Mine ${unique}`;
  const joinedId = await createRoom(me, {
    preset: 'public_chat',
    name: joinedName,
  });
  for (let i = 0; i < 20; i++) {
    const { results } = await api<{ results: { user_id: string }[] }>(
      baseUrl,
      me.accessToken,
      'POST',
      '/user_directory/search',
      { search_term: displayName },
    );
    if (results.some((user) => user.user_id === other.userId)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    me,
    domain: new URL(baseUrl).host,
    publicRoom: { roomId, name, alias: `#room-${unique}:${serverName}` },
    unjoinedRoom: {
      roomId: unjoinedId,
      name: unjoinedName,
      alias: `#plaza-${unique}:${serverName}`,
    },
    joinedRoom: { roomId: joinedId, name: joinedName },
    knockRoom: { roomId: knockId },
    otherUser: { userId: other.userId, displayName },
  };
}
