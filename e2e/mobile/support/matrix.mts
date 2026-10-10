import { createHmac, randomUUID } from 'node:crypto';
import {
  REGISTRATION_SHARED_SECRET,
  HOMESERVER_HTTP,
  SERVER_NAME,
} from '../../support/homeserver/start.mjs';

export function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.url} → ${res.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

export async function registerUser(
  username: string,
  password: string,
): Promise<void> {
  const url = `${HOMESERVER_HTTP}/_synapse/admin/v1/register`;
  const { nonce } = (await json(await fetch(url))) as { nonce: string };
  const mac = createHmac('sha1', REGISTRATION_SHARED_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, username, password, admin: false, mac }),
  });
  if (
    !res.ok &&
    !/already.*exists|user.*taken|M_USER_IN_USE/i.test(await res.text())
  ) {
    throw new Error(`register ${username} → ${res.status}`);
  }
}

export async function accessToken(
  username: string,
  password: string,
): Promise<string> {
  const body = await json(
    await fetch(`${HOMESERVER_HTTP}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
      }),
    }),
  );
  return body['access_token'] as string;
}

export async function createRoom(token: string, name: string): Promise<string> {
  const body = await json(
    await fetch(`${HOMESERVER_HTTP}/_matrix/client/v3/createRoom`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name, preset: 'private_chat' }),
    }),
  );
  return body['room_id'] as string;
}

/** Point a local alias (`#name:server`) at a room. */
export async function createRoomAlias(
  token: string,
  alias: string,
  roomId: string,
): Promise<void> {
  await json(
    await fetch(
      `${HOMESERVER_HTTP}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ room_id: roomId }),
      },
    ),
  );
}

/** Send a plain-text message into a room the user is in; resolves its event id. */
export async function sendMessage(
  token: string,
  roomId: string,
  body: string,
): Promise<string> {
  const response = await json(
    await fetch(
      `${HOMESERVER_HTTP}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${uniqueId('txn')}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ msgtype: 'm.text', body }),
      },
    ),
  );
  return response['event_id'] as string;
}

/** A client-server API call as the token's user; throws unless it succeeds. */
async function clientRequest(
  token: string,
  method: 'POST' | 'PUT',
  path: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return json(
    await fetch(`${HOMESERVER_HTTP}/_matrix/client/v3/${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

export async function inviteUser(
  token: string,
  roomId: string,
  userId: string,
): Promise<void> {
  await clientRequest(
    token,
    'POST',
    `rooms/${encodeURIComponent(roomId)}/invite`,
    {
      user_id: userId,
    },
  );
}

export async function joinRoom(token: string, roomId: string): Promise<void> {
  await clientRequest(token, 'POST', `join/${encodeURIComponent(roomId)}`);
}

/** Replace the user's `m.direct` account data: DM room ids by the other user's id. */
export async function setDirectRooms(
  token: string,
  userId: string,
  direct: Readonly<Record<string, readonly string[]>>,
): Promise<void> {
  await clientRequest(
    token,
    'PUT',
    `user/${encodeURIComponent(userId)}/account_data/m.direct`,
    direct,
  );
}

/** A registered user's named room that a second registered user, the sender, has joined. */
export interface RoomWithSender {
  readonly user: string;
  readonly pass: string;
  readonly userId: string;
  readonly token: string;
  /** The sender's localpart: also its display name, which Synapse defaults to it. */
  readonly sender: string;
  readonly senderId: string;
  readonly senderToken: string;
  readonly roomId: string;
  readonly roomName: string;
}

/** Register a user and a sender, and put both in a new room named after the user. */
export async function roomWithSender(prefix: string): Promise<RoomWithSender> {
  const user = uniqueId(prefix);
  const pass = `${user}-pass`;
  const sender = uniqueId(`${prefix}-sender`);
  const senderPass = `${sender}-pass`;
  const roomName = `Room ${user}`;
  await registerUser(user, pass);
  await registerUser(sender, senderPass);
  const token = await accessToken(user, pass);
  const senderToken = await accessToken(sender, senderPass);
  const roomId = await createRoom(token, roomName);
  const senderId = `@${sender}:${SERVER_NAME}`;
  await inviteUser(token, roomId, senderId);
  await joinRoom(senderToken, roomId);
  return {
    user,
    pass,
    userId: `@${user}:${SERVER_NAME}`,
    token,
    sender,
    senderId,
    senderToken,
    roomId,
    roomName,
  };
}
