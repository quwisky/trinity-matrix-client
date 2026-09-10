import assert from 'node:assert/strict';
import { createNodeAccount, type NodeAccountOptions } from '../support/node-account.mts';
import type { MatrixTestResources } from '../support/test-resources.mts';
import { SYNAPSE_HTTP } from '../support/synapse/start.mjs';

export type NodeWorkspaceAccount = Awaited<ReturnType<typeof createNodeAccount>>;

export interface WorkspaceAccountOptions {
  readonly longName?: boolean;
}

export interface WorkspaceRoomContent {
  readonly name: string;
  readonly preset?: string;
  readonly invite?: readonly string[];
  readonly creation_content?: { readonly type: 'm.space' };
}

export interface WorkspaceRoom {
  readonly id: string;
  readonly name: string;
}

interface AccessSession {
  readonly account: NodeWorkspaceAccount;
  readonly token: string;
}

interface MatrixRecord {
  readonly [key: string]: unknown;
}

const REQUEST_TIMEOUT_MS = 15_000;
const LONG_ACCOUNT_SUFFIX = '-long-display-account-name';

function record(value: unknown, description: string): MatrixRecord {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), description);
  return value as MatrixRecord;
}

function stringField(value: MatrixRecord, field: string, description: string): string {
  assert(field in value && typeof value[field] === 'string' && value[field], description);
  return value[field] as string;
}

/**
 * REST-only fixtures for the Android account/workspace journeys. Tokens remain in this
 * closure and are never returned in an assertion or diagnostic value.
 */
export function createAccountFixtures(
  resources: MatrixTestResources,
  signal: AbortSignal,
): {
  account(role: string, options?: WorkspaceAccountOptions): Promise<NodeWorkspaceAccount>;
  createRoom(account: NodeWorkspaceAccount, content: WorkspaceRoomContent): Promise<WorkspaceRoom>;
  setDisplayName(account: NodeWorkspaceAccount, name: string): Promise<void>;
  invite(account: NodeWorkspaceAccount, roomId: string, invitee: NodeWorkspaceAccount): Promise<void>;
  join(account: NodeWorkspaceAccount, roomId: string): Promise<void>;
  sendMessage(account: NodeWorkspaceAccount, roomId: string, body: string, transactionId: string): Promise<void>;
} {
  const sessions = new Map<string, AccessSession>();
  const accounts = new Map<string, Promise<NodeWorkspaceAccount>>();
  const roomMembers = new Map<string, Set<string>>();

  resources.cleanup('cleanup fixture rooms and accounts', async () => {
    const failures: unknown[] = [];
    for (const [roomId, members] of roomMembers) {
      for (const userId of members) {
        const session = sessions.get(userId);
        if (!session) continue;
        for (const action of ['leave', 'forget'] as const) {
          try {
            await request(
              session,
              `/rooms/${encodeURIComponent(roomId)}/${action}`,
              'POST',
              {},
              AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            );
          } catch (error) {
            failures.push(error);
          }
        }
      }
    }
    for (const session of sessions.values()) {
      try {
        await request(
          session,
          '/logout',
          'POST',
          {},
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, 'Fixture cleanup failed');
    }
  });

  function requestSignal(parent: AbortSignal): AbortSignal {
    return AbortSignal.any([parent, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  }

  async function request(
    session: AccessSession,
    path: string,
    method: 'POST' | 'PUT',
    body: unknown,
    parentSignal: AbortSignal = signal,
  ): Promise<MatrixRecord> {
    const response = await fetch(`${SYNAPSE_HTTP}/_matrix/client/v3${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: requestSignal(parentSignal),
    });
    if (!response.ok) {
      throw new Error(`Matrix fixture ${method} ${path} failed with HTTP ${response.status}`);
    }
    return record(await response.json(), `Matrix fixture ${method} ${path} response`);
  }

  async function login(account: NodeWorkspaceAccount): Promise<AccessSession> {
    const response = await fetch(`${SYNAPSE_HTTP}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: account.username },
        password: account.password,
        initial_device_display_name: 'Android workspace fixture',
      }),
      signal: requestSignal(signal),
    });
    if (!response.ok) {
      throw new Error(`Matrix fixture login failed with HTTP ${response.status}`);
    }
    const body = record(await response.json(), 'Matrix fixture login response');
    assert.equal(stringField(body, 'user_id', 'Matrix fixture login user id'), account.userId);
    const session: AccessSession = {
      account,
      token: stringField(body, 'access_token', 'Matrix fixture login token'),
    };
    sessions.set(account.userId, session);
    return session;
  }

  async function account(
    role: string,
    options: WorkspaceAccountOptions = {},
  ): Promise<NodeWorkspaceAccount> {
    const suffix = options.longName ? LONG_ACCOUNT_SUFFIX : '';
    const key = `${role}\0${suffix}`;
    const existing = accounts.get(key);
    if (existing) return existing;
    const nodeOptions: NodeAccountOptions = suffix ? { usernameSuffix: suffix } : {};
    const pending = (async () => {
      const created = await createNodeAccount(resources, signal, role, nodeOptions);
      await login(created);
      return created;
    })();
    accounts.set(key, pending);
    return pending;
  }

  function access(account: NodeWorkspaceAccount): AccessSession {
    const session = sessions.get(account.userId);
    assert(session, `No Matrix fixture session for ${account.userId}`);
    return session;
  }

  async function createRoom(
    owner: NodeWorkspaceAccount,
    content: WorkspaceRoomContent,
  ): Promise<WorkspaceRoom> {
    const response = await request(access(owner), '/createRoom', 'POST', {
      name: content.name,
      ...(content.preset ? { preset: content.preset } : {}),
      ...(content.invite ? { invite: content.invite } : {}),
      ...(content.creation_content ? { creation_content: content.creation_content } : {}),
    });
    const id = stringField(response, 'room_id', 'Matrix fixture room id');
    roomMembers.set(id, new Set([owner.userId]));
    return { id, name: content.name };
  }

  async function setDisplayName(owner: NodeWorkspaceAccount, name: string): Promise<void> {
    await request(
      access(owner),
      `/profile/${encodeURIComponent(owner.userId)}/displayname`,
      'PUT',
      { displayname: name },
    );
  }

  async function invite(
    owner: NodeWorkspaceAccount,
    roomId: string,
    invitee: NodeWorkspaceAccount,
  ): Promise<void> {
    await request(
      access(owner),
      `/rooms/${encodeURIComponent(roomId)}/invite`,
      'POST',
      { user_id: invitee.userId },
    );
  }

  async function join(member: NodeWorkspaceAccount, roomId: string): Promise<void> {
    await request(access(member), `/rooms/${encodeURIComponent(roomId)}/join`, 'POST', {});
    const members = roomMembers.get(roomId);
    assert(members, `Unknown Matrix fixture room ${roomId}`);
    members.add(member.userId);
  }

  async function sendMessage(
    sender: NodeWorkspaceAccount,
    roomId: string,
    body: string,
    transactionId: string,
  ): Promise<void> {
    await request(
      access(sender),
      `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
      'PUT',
      { msgtype: 'm.text', body },
    );
  }

  return { account, createRoom, setDisplayName, invite, join, sendMessage };
}
