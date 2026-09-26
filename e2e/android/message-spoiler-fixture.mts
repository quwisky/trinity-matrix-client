import assert from 'node:assert/strict';
import { SYNAPSE_HTTP } from '../support/synapse/start.mjs';
import type { MatrixTestResources } from '../support/test-resources.mts';
import type { NodeWorkspaceAccount } from './account-workspace-fixtures.mts';
import type { SpoilerContent } from './message-spoiler-contract.mts';

type FetchLike = typeof fetch;

const REQUEST_TIMEOUT_MS = 15_000;

class MessageSpoilerFixtureHttpError extends Error {
  readonly status: number;

  constructor(status: number, method: string, operation: string) {
    super(`Message-spoiler fixture ${method} ${operation} failed with HTTP ${status}`);
    this.name = 'MessageSpoilerFixtureHttpError';
    this.status = status;
  }
}

/**
 * Lines 51–62: the one formatted spoiler message, sent through real Synapse.
 * The shared fixtures send only plain `m.text`, so this owns a private REST
 * session. Its access token stays in this closure, never reaches an error
 * message or diagnostic, and is logged out in a bounded cleanup.
 */
export function createMessageSpoilerFixtures(
  resources: Pick<MatrixTestResources, 'cleanup'>,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): {
  sendSpoiler(
    account: NodeWorkspaceAccount,
    roomId: string,
    transactionId: string,
    content: SpoilerContent,
  ): Promise<string>;
} {
  const sessions = new Map<string, string>();

  const request = async (
    path: string,
    method: 'POST' | 'PUT',
    operation: string,
    token: string | undefined,
    body: unknown,
    parent: AbortSignal = signal,
  ): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(`${SYNAPSE_HTTP}/_matrix/client/v3${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([parent, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new MessageSpoilerFixtureHttpError(response.status, method, operation);
    const value: unknown = await response.json();
    assert(value !== null && typeof value === 'object' && !Array.isArray(value),
      `Message-spoiler fixture ${operation} returned an object`);
    return value as Record<string, unknown>;
  };

  resources.cleanup('Message-spoiler REST session', async () => {
    const failures: unknown[] = [];
    for (const token of sessions.values()) {
      try {
        await request('/logout', 'POST', 'logout', token, {}, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
      } catch (error) {
        failures.push(error);
      }
    }
    sessions.clear();
    if (failures.length)
      throw new AggregateError(failures, 'Message-spoiler REST logout failed');
  });

  const access = async (account: NodeWorkspaceAccount): Promise<string> => {
    const saved = sessions.get(account.userId);
    if (saved) return saved;
    const login = await request('/login', 'POST', 'login', undefined, {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: account.username },
      password: account.password,
      initial_device_display_name: 'Android message-spoiler fixture',
    });
    assert.equal(login['user_id'], account.userId, 'Message-spoiler REST account');
    const token = login['access_token'];
    assert(typeof token === 'string' && token.length > 0, 'Message-spoiler REST access token');
    sessions.set(account.userId, token);
    return token;
  };

  async function sendSpoiler(
    account: NodeWorkspaceAccount,
    roomId: string,
    transactionId: string,
    content: SpoilerContent,
  ): Promise<string> {
    const token = await access(account);
    const sent = await request(
      `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
      'PUT',
      'send',
      token,
      content,
    );
    const eventId = sent['event_id'];
    assert(typeof eventId === 'string' && eventId.startsWith('$'),
      'Message-spoiler sent event id');
    return eventId;
  }

  return { sendSpoiler };
}
