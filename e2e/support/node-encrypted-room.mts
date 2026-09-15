import assert from 'node:assert/strict';
import { SYNAPSE_HTTP } from './synapse/start.mjs';
import type { createNodeAccount } from './node-account.mts';
import type { MatrixTestResources } from './test-resources.mts';

type NodeAccount = Awaited<ReturnType<typeof createNodeAccount>>;

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Seed membership and encryption state only. Messages must come from real clients. */
export async function createNodeEncryptedRoom(
  resources: MatrixTestResources,
  accounts: readonly [NodeAccount, NodeAccount],
  signal: AbortSignal,
): Promise<{
  readonly id: string;
  readonly name: string;
  readMessages(): Promise<readonly Record<string, unknown>[]>;
}> {
  async function request(
    path: string,
    token?: string,
    body?: unknown,
    requestSignal = signal,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${SYNAPSE_HTTP}/_matrix/client/v3${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]),
    });
    assert.equal(response.status, 200, `Matrix fixture ${path.split('?')[0]}`);
    return record(await response.json());
  }

  const sessions: Array<{ readonly userId: string; readonly token: string }> =
    [];
  for (const account of accounts) {
    const session = await request('/login', undefined, {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: account.username },
      password: account.password,
      initial_device_display_name: 'Fixture preparation only',
    });
    assert(typeof session['user_id'] === 'string');
    assert(typeof session['access_token'] === 'string');
    const token = session['access_token'];
    sessions.push({ userId: session['user_id'], token });
    resources.cleanup(`Fixture session ${account.username}`, async () => {
      await request('/logout', token, {}, AbortSignal.timeout(15_000));
    });
  }
  const [primary, secondary] = sessions;
  assert(primary && secondary);
  const name = resources.roomName('encrypted');
  const room = await request('/createRoom', primary.token, {
    name,
    preset: 'private_chat',
    invite: [secondary.userId],
    initial_state: [
      {
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      },
    ],
  });
  assert(typeof room['room_id'] === 'string');
  const id = room['room_id'];
  await request(`/join/${encodeURIComponent(id)}`, secondary.token, {});
  return {
    id,
    name,
    async readMessages() {
      const response = await request(
        `/rooms/${encodeURIComponent(id)}/messages?dir=b&limit=100`,
        primary.token,
      );
      assert(Array.isArray(response['chunk']), 'Matrix room event chunk');
      return response['chunk']
        .map(record)
        .filter((event) =>
          ['m.room.message', 'm.room.encrypted'].includes(
            String(event['type']),
          ),
        );
    },
  };
}
