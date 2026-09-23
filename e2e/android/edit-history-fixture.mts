import assert from 'node:assert/strict';
import { SYNAPSE_HTTP } from '../support/synapse/start.mjs';
import type { MatrixTestResources } from '../support/test-resources.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
} from './account-workspace-fixtures.mts';

type FetchLike = typeof fetch;

export interface LifecycleSeed {
  readonly roomId: string;
  readonly roomName: string;
  readonly plain: {
    readonly originalId: string;
    readonly editIds: readonly [string, string];
    readonly versions: readonly string[];
  };
  readonly formatted: { readonly originalId: string; readonly editId: string };
  readonly doomed: {
    readonly originalId: string;
    readonly editId: string;
    readonly body: string;
  };
}

export interface PixelSeed {
  readonly roomId: string;
  readonly roomName: string;
  readonly originalId: string;
  readonly editIds: readonly [string, string];
  readonly versions: readonly string[];
}

export interface EditHistoryServerProof {
  readonly removedRedacted: true;
  readonly liveCount: number;
  readonly survivorMatches: true;
}

/** Owns a private REST session while composing the existing account/room fixture. */
export function createEditHistoryFixtures(
  resources: MatrixTestResources,
  signal: AbortSignal,
  base: ReturnType<typeof createAccountFixtures>,
  fetchImpl: FetchLike = fetch,
): {
  lifecycle(account: NodeWorkspaceAccount, roomName: string, runId: string): Promise<LifecycleSeed>;
  pixel5(account: NodeWorkspaceAccount, roomName: string, runId: string): Promise<PixelSeed>;
  serverState(
    account: NodeWorkspaceAccount,
    roomId: string,
    originalId: string,
    allEditIds: readonly string[],
    expectedLiveIds: readonly string[],
  ): Promise<EditHistoryServerProof>;
  redactedOriginal(
    account: NodeWorkspaceAccount,
    roomId: string,
    originalId: string,
  ): Promise<void>;
  liveEditEvent(
    account: NodeWorkspaceAccount,
    roomId: string,
    originalId: string,
    editId: string,
  ): Promise<void>;
} {
  const sessions = new Map<string, string>();
  const sentContents = new Map<string, unknown>();

  const request = async (
    version: 'v1' | 'v3',
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    token?: string,
    body?: unknown,
    requestSignal: AbortSignal = signal,
  ): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(`${SYNAPSE_HTTP}/_matrix/client/${version}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok)
      throw new Error(`Edit-history ${method} ${path} HTTP ${response.status}`);
    const value: unknown = await response.json();
    assert(value && typeof value === 'object' && !Array.isArray(value),
      `Edit-history ${method} ${path} returned an invalid object`);
    return value as Record<string, unknown>;
  };

  resources.cleanup('Edit-history REST sessions', async () => {
    const failures: unknown[] = [];
    for (const token of sessions.values()) {
      try {
        await request('v3', '/logout', 'POST', token, {}, AbortSignal.timeout(15_000));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Edit-history logout failed');
  });

  const access = async (account: NodeWorkspaceAccount): Promise<string> => {
    const saved = sessions.get(account.userId);
    if (saved) return saved;
    const login = await request('v3', '/login', 'POST', undefined, {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: account.username },
      password: account.password,
    });
    assert.equal(login['user_id'], account.userId, 'Edit-history REST account');
    assert(typeof login['access_token'] === 'string' && login['access_token'],
      'Edit-history REST access token');
    const token = login['access_token'];
    sessions.set(account.userId, token);
    return token;
  };

  const send = async (
    token: string,
    roomId: string,
    txn: string,
    content: unknown,
  ): Promise<string> => {
    const response = await request(
      'v3',
      `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txn)}`,
      'PUT',
      token,
      content,
    );
    assert(typeof response['event_id'] === 'string' && response['event_id'],
      'Edit-history sent event ID');
    sentContents.set(response['event_id'], content);
    return response['event_id'];
  };

  const edit = (target: string, body: string) => ({
    msgtype: 'm.text',
    body: `* ${body}`,
    'm.new_content': { msgtype: 'm.text', body },
    'm.relates_to': { rel_type: 'm.replace', event_id: target },
  });
  const formattedEdit = (target: string, runId: string) => ({
    msgtype: 'm.text',
    body: `* deploy on Monday ${runId}`,
    'm.new_content': {
      msgtype: 'm.text',
      body: `deploy on Monday ${runId}`,
      format: 'org.matrix.custom.html',
      formatted_body: `deploy on <strong>Monday</strong> ${runId}`,
    },
    'm.relates_to': { rel_type: 'm.replace', event_id: target },
  });

  const lifecycle = async (
    account: NodeWorkspaceAccount,
    roomName: string,
    runId: string,
  ): Promise<LifecycleSeed> => {
    const token = await access(account);
    const room = await base.createRoom(account, {
      name: roomName,
      preset: 'private_chat',
    });
    const versions = [
      `first draft ${runId}`,
      `second draft ${runId}`,
      `final wording ${runId}`,
    ];
    const originalId = await send(token, room.id, `${runId}-orig`, {
      msgtype: 'm.text',
      body: versions[0],
    });
    const edit1 = await send(token, room.id, `${runId}-edit1`,
      edit(originalId, versions[1]!));
    const edit2 = await send(token, room.id, `${runId}-edit2`,
      edit(originalId, versions[2]!));
    const formattedId = await send(token, room.id, `${runId}-fmt`, {
      msgtype: 'm.text',
      body: `deploy on Friday ${runId}`,
      format: 'org.matrix.custom.html',
      formatted_body: `deploy on <strong>Friday</strong> ${runId}`,
    });
    const formattedEditId = await send(token, room.id, `${runId}-fmt-edit`,
      formattedEdit(formattedId, runId));
    const doomedBody = `deleted message ${runId}`;
    const doomedId = await send(token, room.id, `${runId}-doomed`, {
      msgtype: 'm.text', body: doomedBody,
    });
    const doomedEditId = await send(token, room.id, `${runId}-doomed-edit`,
      edit(doomedId, `${doomedBody} (edited)`));
    await request(
      'v3',
      `/rooms/${encodeURIComponent(room.id)}/redact/${encodeURIComponent(doomedId)}/${encodeURIComponent(`${runId}-redact`)}`,
      'PUT',
      token,
      {},
    );
    return {
      roomId: room.id,
      roomName,
      plain: { originalId, editIds: [edit1, edit2], versions },
      formatted: { originalId: formattedId, editId: formattedEditId },
      doomed: { originalId: doomedId, editId: doomedEditId, body: doomedBody },
    };
  };

  const pixel5 = async (
    account: NodeWorkspaceAccount,
    roomName: string,
    runId: string,
  ): Promise<PixelSeed> => {
    const token = await access(account);
    const room = await base.createRoom(account, {
      name: roomName,
      preset: 'private_chat',
    });
    const versions = ['first draft', 'second draft', 'final wording'].map(
      (prefix) => `${prefix} ${runId} ${'long content '.repeat(60)}`,
    );
    const originalId = await send(token, room.id, `${runId}-orig`, {
      msgtype: 'm.text', body: versions[0],
    });
    const firstEdit = await send(token, room.id, `${runId}-edit1`,
      edit(originalId, versions[1]!));
    const finalEdit = await send(token, room.id, `${runId}-edit2`,
      edit(originalId, versions[2]!));
    return { roomId: room.id, roomName, originalId,
      editIds: [firstEdit, finalEdit], versions };
  };

  const serverState = async (
    account: NodeWorkspaceAccount,
    roomId: string,
    originalId: string,
    allEditIds: readonly string[],
    expectedLiveIds: readonly string[],
  ): Promise<EditHistoryServerProof> => {
    const token = await access(account);
    const encodedRoom = encodeURIComponent(roomId);
    for (const id of allEditIds) {
      const event = await request(
        'v3',
        `/rooms/${encodedRoom}/event/${encodeURIComponent(id)}`,
        'GET',
        token,
      );
      assert.equal(event['sender'], account.userId, 'Edit event sender');
      if (expectedLiveIds.includes(id)) {
        assert.deepEqual(event['content'], sentContents.get(id),
          'Live edit retains its exact wire content');
      } else {
        assert.deepEqual(event['content'], {}, 'Removed edit has no live content');
        assert((event['unsigned'] as Record<string, unknown> | undefined)?.['redacted_because'],
          'Removed edit is redacted');
      }
    }
    const liveIds: string[] = [];
    const seenCursors = new Set<string>();
    let pages = 0;
    let from: string | undefined;
    do {
      assert(++pages <= 10, 'Edit relations have bounded pagination');
      const query = new URLSearchParams({
        dir: 'b', limit: '50', ...(from ? { from } : {}),
      });
      const page = await request(
        'v1',
        `/rooms/${encodedRoom}/relations/${encodeURIComponent(originalId)}/m.replace/m.room.message?${query}`,
        'GET',
        token,
      );
      assert(Array.isArray(page['chunk']), 'Edit relations include a chunk');
      for (const value of page['chunk']) {
        assert(value && typeof value === 'object' && !Array.isArray(value),
          'Edit relation is an object');
        const event = value as Record<string, unknown>;
        if ((event['unsigned'] as Record<string, unknown> | undefined)?.['redacted_because'])
          continue;
        assert.equal(event['type'], 'm.room.message', 'Edit relation type');
        assert.equal(event['sender'], account.userId, 'Edit relation sender');
        assert.deepEqual(
          (event['content'] as Record<string, unknown>)?.['m.relates_to'],
          { rel_type: 'm.replace', event_id: originalId },
          'Edit relation m.relates_to targets the original',
        );
        assert(typeof event['event_id'] === 'string', 'Edit relation event ID');
        assert.deepEqual(event['content'], sentContents.get(event['event_id']),
          'Edit relation content matches seeded wire event');
        liveIds.push(event['event_id']);
      }
      from = typeof page['next_batch'] === 'string' ? page['next_batch'] : undefined;
      if (from) {
        assert(!seenCursors.has(from), 'Edit relations cursor advances');
        seenCursors.add(from);
      }
    } while (from);
    assert.deepEqual(liveIds, [...expectedLiveIds].reverse(),
      'Exact live edit order');
    return {
      removedRedacted: true,
      liveCount: liveIds.length,
      survivorMatches: true,
    };
  };

  const redactedOriginal = async (
    account: NodeWorkspaceAccount,
    roomId: string,
    originalId: string,
  ): Promise<void> => {
    const token = await access(account);
    const event = await request(
      'v3',
      `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(originalId)}`,
      'GET',
      token,
    );
    assert.equal(event['sender'], account.userId, 'Redacted original sender');
    assert.deepEqual(event['content'], {}, 'Redacted original has no content');
    assert((event['unsigned'] as Record<string, unknown> | undefined)?.['redacted_because'],
      'Redacted original retains server redaction proof');
  };

  // Synapse suppresses /relations on a redacted parent. A direct event read
  // still proves that its edit remains live with the exact wire payload.
  const liveEditEvent = async (
    account: NodeWorkspaceAccount,
    roomId: string,
    originalId: string,
    editId: string,
  ): Promise<void> => {
    const token = await access(account);
    const event = await request(
      'v3',
      `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(editId)}`,
      'GET',
      token,
    );
    assert.equal(event['sender'], account.userId, 'Live edit sender');
    assert.equal(event['type'], 'm.room.message', 'Live edit event type');
    assert.deepEqual(
      (event['content'] as Record<string, unknown>)?.['m.relates_to'],
      { rel_type: 'm.replace', event_id: originalId },
      'Live edit still targets the redacted original',
    );
    assert.deepEqual(event['content'], sentContents.get(editId),
      'Live edit retains its exact wire content');
    assert(!(event['unsigned'] as Record<string, unknown> | undefined)?.['redacted_because'],
      'Live edit itself is not redacted');
  };

  return { lifecycle, pixel5, serverState, redactedOriginal, liveEditEvent };
}
