import assert from 'node:assert/strict';
import { SYNAPSE_HTTP } from '../support/synapse/start.mjs';
import type { MatrixTestResources } from '../support/test-resources.mts';
import type { NodeWorkspaceAccount } from './account-workspace-fixtures.mts';
import { THREAD_BODY } from './message-unread-contract.mts';

type FetchLike = typeof fetch;

const REQUEST_TIMEOUT_MS = 15_000;

class MessageUnreadFixtureHttpError extends Error {
  readonly status: number;

  constructor(status: number, method: string, operation: string) {
    super(`Message-unread fixture ${method} ${operation} failed with HTTP ${status}`);
    this.name = 'MessageUnreadFixtureHttpError';
    this.status = status;
  }
}

interface RequestOptions {
  readonly allowNotFound?: boolean;
  readonly parent?: AbortSignal;
}

/**
 * Lines 116-154: both read markers, the thread relation and the
 * `m.fully_read` read-back, sent through real Synapse. The shared fixtures
 * send only plain `m.text` and never touch account data, so this owns a
 * private REST session. Its access tokens stay in this closure, never reach
 * an error message or diagnostic, and are logged out in a bounded cleanup.
 */
export function createMessageUnreadFixtures(
  resources: Pick<MatrixTestResources, 'cleanup'>,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): {
  setReadMarkers(account: NodeWorkspaceAccount, roomId: string, eventId: string): Promise<void>;
  sendThreadReply(
    account: NodeWorkspaceAccount,
    roomId: string,
    transactionId: string,
    rootId: string,
  ): Promise<string>;
  fullyRead(account: NodeWorkspaceAccount, roomId: string): Promise<string | undefined>;
  tokens(): readonly string[];
} {
  const sessions = new Map<string, string>();

  const request = async (
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    operation: string,
    token: string | undefined,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown> | undefined> => {
    const response = await fetchImpl(`${SYNAPSE_HTTP}/_matrix/client/v3${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([options.parent ?? signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (options.allowNotFound && response.status === 404) return undefined;
    if (!response.ok) throw new MessageUnreadFixtureHttpError(response.status, method, operation);
    const value: unknown = await response.json();
    assert(value !== null && typeof value === 'object' && !Array.isArray(value),
      `Message-unread fixture ${operation} returned an object`);
    return value as Record<string, unknown>;
  };

  resources.cleanup('Message-unread REST session', async () => {
    const failures: unknown[] = [];
    for (const token of sessions.values()) {
      try {
        await request('/logout', 'POST', 'logout', token, {}, {
          parent: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        failures.push(error);
      }
    }
    sessions.clear();
    if (failures.length)
      throw new AggregateError(failures, 'Message-unread REST logout failed');
  });

  const access = async (account: NodeWorkspaceAccount): Promise<string> => {
    const saved = sessions.get(account.userId);
    if (saved) return saved;
    const login = await request('/login', 'POST', 'login', undefined, {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: account.username },
      password: account.password,
      initial_device_display_name: 'Android message-unread fixture',
    });
    assert.equal(login?.['user_id'], account.userId, 'Message-unread REST account');
    const token = login?.['access_token'];
    assert(typeof token === 'string' && token.length > 0, 'Message-unread REST access token');
    sessions.set(account.userId, token);
    return token;
  };

  async function setReadMarkers(
    account: NodeWorkspaceAccount,
    roomId: string,
    eventId: string,
  ): Promise<void> {
    const token = await access(account);
    await request(
      `/rooms/${encodeURIComponent(roomId)}/read_markers`,
      'POST',
      'read markers',
      token,
      { 'm.fully_read': eventId, 'm.read': eventId },
    );
  }

  async function sendThreadReply(
    account: NodeWorkspaceAccount,
    roomId: string,
    transactionId: string,
    rootId: string,
  ): Promise<string> {
    const token = await access(account);
    const sent = await request(
      `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
      'PUT',
      'send',
      token,
      {
        msgtype: 'm.text',
        body: THREAD_BODY,
        'm.relates_to': {
          rel_type: 'm.thread',
          event_id: rootId,
          'm.in_reply_to': { event_id: rootId },
        },
      },
    );
    const eventId = sent?.['event_id'];
    assert(typeof eventId === 'string' && eventId.startsWith('$'),
      'Message-unread thread reply event id');
    return eventId;
  }

  async function fullyRead(
    account: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<string | undefined> {
    const token = await access(account);
    const value = await request(
      `/user/${encodeURIComponent(account.userId)}/rooms/${encodeURIComponent(roomId)}/account_data/m.fully_read`,
      'GET',
      'fully-read account data',
      token,
      undefined,
      { allowNotFound: true },
    );
    if (value === undefined) return undefined;
    const eventId = value['event_id'];
    assert(typeof eventId === 'string' && eventId.length > 0,
      'Message-unread fully-read event id');
    return eventId;
  }

  return {
    setReadMarkers,
    sendThreadReply,
    fullyRead,
    tokens: () => [...sessions.values()],
  };
}
