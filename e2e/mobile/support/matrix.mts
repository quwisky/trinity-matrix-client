import { createHmac, randomUUID } from 'node:crypto';
import {
  REGISTRATION_SHARED_SECRET,
  HOMESERVER_HTTP,
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
