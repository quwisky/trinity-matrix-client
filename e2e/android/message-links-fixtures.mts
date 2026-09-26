import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readSession, type E2ESessionDescriptor } from '../support/session.mts';
import { SECONDARY_HTTP, SYNAPSE_HTTP } from '../support/synapse/start.mjs';
import type { MatrixTestResources } from '../support/test-resources.mts';
import type { NodeWorkspaceAccount } from './account-workspace-fixtures.mts';

type FetchLike = typeof fetch;
type Server = 'primary' | 'secondary';
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface MatrixRecord {
  readonly [key: string]: unknown;
}

interface MatrixResponse {
  readonly status: number;
  readonly body: MatrixRecord;
}

/**
 * A remote Room the cleanup owns. It is recorded before `POST /createRoom`, so a
 * create whose response is lost (timeout, abort, dropped connection) is still
 * cleaned up: `roomId` stays unknown until the response names it.
 */
interface RemoteRoomRecord {
  readonly ownerId: string;
  roomId: string | undefined;
  readonly alias: string | undefined;
}

export interface SecondaryDescriptor {
  readonly hs: string;
  readonly serverName: string;
}

export interface RemoteAccount {
  readonly userId: string;
  readonly localpart: string;
}

export type MembershipState =
  | 'join'
  | 'leave'
  | 'invite'
  | 'ban'
  | 'knock'
  | 'absent';

export interface RemoteRoomContent {
  readonly name: string;
  readonly topic?: string;
  readonly preset: 'public_chat' | 'private_chat';
  readonly visibility?: 'public';
  readonly aliasLocalpart?: string;
}

export interface RemoteRoom {
  readonly id: string;
  readonly alias?: string;
  readonly joinRule: string;
  readonly name: string;
  readonly topic?: string;
  readonly published: boolean;
}

export interface FederationProbe {
  readonly polls: number;
  readonly ms: number;
}

export interface MessageLinksFixtures {
  apiLogin(account: NodeWorkspaceAccount): Promise<{ userId: string }>;
  registerRemote(localpart: string): Promise<RemoteAccount>;
  createRemoteRoom(
    owner: RemoteAccount,
    content: RemoteRoomContent,
  ): Promise<RemoteRoom>;
  sendRoomLink(
    account: NodeWorkspaceAccount,
    roomId: string,
    href: string,
    label: string,
    txnId: string,
  ): Promise<{ eventId: string }>;
  sendFormatted(
    account: NodeWorkspaceAccount,
    roomId: string,
    content: { body: string; formattedBody: string },
    txnId: string,
  ): Promise<{ eventId: string }>;
  event(
    account: NodeWorkspaceAccount,
    roomId: string,
    eventId: string,
  ): Promise<{ body: string; format: string; formattedBody: string }>;
  awaitAliasFederation(
    account: NodeWorkspaceAccount,
    alias: string,
    expectedRoomId: string,
  ): Promise<FederationProbe>;
  awaitProfileFederation(
    account: NodeWorkspaceAccount,
    remoteUserId: string,
  ): Promise<FederationProbe>;
  setRemoteJoinRule(
    owner: RemoteAccount,
    roomId: string,
    rule: 'invite',
  ): Promise<{ status: number; readBack: string }>;
  /** Read-only: the current remote `m.room.join_rules` state, read as the owner. */
  remoteJoinRule(owner: RemoteAccount, roomId: string): Promise<string>;
  /** `parentSignal` lets a failure path read on its own bound after an abort. */
  remoteMembership(
    owner: RemoteAccount,
    roomId: string,
    userId: string,
    parentSignal?: AbortSignal,
  ): Promise<MembershipState>;
  leaveLocal(account: NodeWorkspaceAccount, roomId: string): Promise<void>;
  displayName(
    observer: NodeWorkspaceAccount,
    userId: string,
  ): Promise<string | undefined>;
}

export const MESSAGE_LINKS_REQUEST_TIMEOUT_MS = 15_000;
export const MESSAGE_LINKS_PROBE_INTERVAL_MS = 1_000;
export const MESSAGE_LINKS_PROBE_TIMEOUT_MS = 60_000;
/** Federation warm-up statuses. 429 and every other status fail immediately. */
export const MESSAGE_LINKS_PROBE_TOLERATED_STATUSES: readonly number[] =
  Object.freeze([404, 502, 503, 504]);

const MEMBERSHIP_STATES: readonly MembershipState[] = [
  'join',
  'leave',
  'invite',
  'ban',
  'knock',
];
const SERVER_NAME_PATTERN = /^[A-Za-z0-9.\-[\]:]+$/;
const LOCALPART_PATTERN = /^[a-z0-9._=\-/+]+$/;
const ERRCODE_PATTERN = /^M_[A-Z_]+$/;

/**
 * An HTTP failure that names only the server, method, path template, status and
 * Matrix errcode. Ids and response text never reach the message, so a failure
 * can be recorded in journeys.json without redaction.
 */
export class MessageLinksHttpError extends Error {
  readonly server: Server;
  readonly method: Method;
  readonly template: string;
  readonly status: number;
  readonly errcode: string | undefined;

  constructor(
    server: Server,
    method: Method,
    template: string,
    status: number,
    errcode: string | undefined,
  ) {
    super(
      `Message-links ${server} ${method} ${template} failed with HTTP ${status}${errcode ? ` ${errcode}` : ''}`,
    );
    this.name = 'MessageLinksHttpError';
    this.server = server;
    this.method = method;
    this.template = template;
    this.status = status;
    this.errcode = errcode;
  }
}

function isRecord(value: unknown): value is MatrixRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function stringField(
  value: MatrixRecord,
  field: string,
  description: string,
): string {
  const candidate = value[field];
  assert(nonEmptyString(candidate), description);
  return candidate;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

function assertSecondary(value: unknown): asserts value is SecondaryDescriptor {
  assert(isRecord(value), 'Message-links requires the federated secondary Synapse');
  assert(
    nonEmptyString(value['hs']),
    'Message-links secondary Synapse has no client URL',
  );
  assert(
    value['hs'] === SECONDARY_HTTP,
    'Message-links secondary Synapse must use the harness secondary client URL',
  );
  assert(
    nonEmptyString(value['serverName']) &&
      SERVER_NAME_PATTERN.test(value['serverName']),
    'Message-links secondary Synapse has no valid server name',
  );
}

/**
 * Reads the federated secondary Synapse from the invocation session. Fail-closed:
 * the client URL must be the harness secondary URL, and the server name and
 * registration secret must be present. The secret itself is never returned.
 */
export function readSecondary(
  session: E2ESessionDescriptor = readSession(),
): SecondaryDescriptor {
  assert(
    session.synapse?.available === true,
    'Message-links requires the disposable Synapse',
  );
  const secondary = session.synapse.secondary;
  assert(
    isRecord(secondary),
    'Message-links requires the federated secondary Synapse',
  );
  assert(
    nonEmptyString(secondary['registrationSecret']),
    'Message-links secondary Synapse has no registration secret',
  );
  const descriptor = { hs: secondary['hs'], serverName: secondary['serverName'] };
  assertSecondary(descriptor);
  return descriptor;
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Two-server REST fixtures for the Android Matrix-link journeys. They arrange,
 * alter and observe exact local and federated state only. Every access token stays
 * in this closure. Register this before `createAccountFixtures(resources, signal)`
 * so that the base Room/account cleanup runs first (namespace cleanups run LIFO).
 */
export function createMessageLinksFixtures(options: {
  readonly resources: MatrixTestResources;
  readonly signal: AbortSignal;
  readonly secondary?: SecondaryDescriptor;
  readonly fetchImpl?: FetchLike;
}): MessageLinksFixtures {
  const { resources, signal } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const secondary = options.secondary ?? readSecondary();
  assertSecondary(secondary);
  const serverName = secondary.serverName;

  const primaryTokens = new Map<string, string[]>();
  const apiSessions = new Set<string>();
  const remoteTokens = new Map<string, string>();
  const remoteRooms: RemoteRoomRecord[] = [];

  async function request(
    server: Server,
    token: string | undefined,
    method: Method,
    template: string,
    params: Readonly<Record<string, string>>,
    body?: unknown,
    parentSignal: AbortSignal = signal,
    accept: readonly number[] = [],
  ): Promise<MatrixResponse> {
    const path = template.replace(/\{([A-Za-z]+)\}/g, (_match, key: string) => {
      const value = params[key];
      assert(
        nonEmptyString(value),
        `Message-links ${method} ${template} is missing a path parameter`,
      );
      return encodeURIComponent(value);
    });
    const base = server === 'primary' ? SYNAPSE_HTTP : SECONDARY_HTTP;
    let response: Response;
    try {
      response = await fetchImpl(`${base}/_matrix/client/v3${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([
          parentSignal,
          AbortSignal.timeout(MESSAGE_LINKS_REQUEST_TIMEOUT_MS),
        ]),
      });
    } catch (error) {
      throw new Error(
        `Message-links ${server} ${method} ${template} did not complete (${errorName(error)})`,
      );
    }
    if (!response.ok && (response.status === 429 || !accept.includes(response.status))) {
      let errcode: string | undefined;
      try {
        const failure: unknown = await response.json();
        if (
          isRecord(failure) &&
          typeof failure['errcode'] === 'string' &&
          ERRCODE_PATTERN.test(failure['errcode'])
        ) {
          errcode = failure['errcode'];
        }
      } catch {
        errcode = undefined;
      }
      throw new MessageLinksHttpError(
        server,
        method,
        template,
        response.status,
        errcode,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, body: {} };
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      throw new Error(
        `Message-links ${server} ${method} ${template} returned invalid JSON (${errorName(error)})`,
      );
    }
    assert(
      isRecord(value),
      `Message-links ${server} ${method} ${template} returned an invalid object`,
    );
    return { status: response.status, body: value };
  }

  // Registered before the base account fixture, so it runs after the base cleanup
  // has left and forgotten every tracked local Room and logged the base sessions out.
  resources.cleanup('Message-links two-server REST cleanup', async () => {
    const failures: unknown[] = [];
    const step = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    const own = (): AbortSignal =>
      AbortSignal.timeout(MESSAGE_LINKS_REQUEST_TIMEOUT_MS);

    for (const tokens of primaryTokens.values()) {
      for (const token of tokens) {
        await step(() =>
          request('primary', token, 'POST', '/logout', {}, {}, own()),
        );
      }
    }
    // Ids of every Room whose create response arrived, so that discovering a
    // pending Room through the owner's joined Rooms never repeats a known one.
    const known = new Set(
      remoteRooms.flatMap((room) => (room.roomId ? [room.roomId] : [])),
    );
    /** Resolve a Room whose create response was lost, from its alias or its owner. */
    const discover = async (
      room: RemoteRoomRecord,
      token: string,
    ): Promise<readonly string[]> => {
      if (room.alias) {
        const resolved = await request(
          'secondary',
          token,
          'GET',
          '/directory/room/{alias}',
          { alias: room.alias },
          undefined,
          own(),
          [404],
        );
        const roomId = resolved.body['room_id'];
        return nonEmptyString(roomId) ? [roomId] : [];
      }
      // A fresh remote owner is joined only to the Rooms it created.
      const joined = (
        await request('secondary', token, 'GET', '/joined_rooms', {}, undefined, own())
      ).body['joined_rooms'];
      assert(
        Array.isArray(joined) && joined.every(nonEmptyString),
        'Message-links remote owner joined Rooms are invalid',
      );
      return joined.filter((roomId) => !known.has(roomId));
    };
    for (const room of [...remoteRooms].reverse()) {
      const token = remoteTokens.get(room.ownerId);
      if (!token) {
        failures.push(
          new Error('Message-links remote Room owner has no cleanup session'),
        );
        continue;
      }
      let roomIds: readonly string[] = room.roomId ? [room.roomId] : [];
      if (!room.roomId) {
        await step(async () => {
          roomIds = await discover(room, token);
          for (const roomId of roomIds) known.add(roomId);
        });
      }
      const alias = room.alias;
      if (alias) {
        await step(() =>
          request(
            'secondary',
            token,
            'DELETE',
            '/directory/room/{alias}',
            { alias },
            undefined,
            own(),
            [404],
          ),
        );
      }
      for (const roomId of roomIds) {
        await step(() =>
          request(
            'secondary',
            token,
            'PUT',
            '/directory/list/room/{roomId}',
            { roomId },
            { visibility: 'private' },
            own(),
          ),
        );
        await step(() =>
          request(
            'secondary',
            token,
            'POST',
            '/rooms/{roomId}/leave',
            { roomId },
            {},
            own(),
          ),
        );
        await step(() =>
          request(
            'secondary',
            token,
            'POST',
            '/rooms/{roomId}/forget',
            { roomId },
            {},
            own(),
          ),
        );
      }
    }
    for (const token of remoteTokens.values()) {
      await step(() =>
        request('secondary', token, 'POST', '/logout', {}, {}, own()),
      );
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        'Message-links two-server cleanup failed',
      );
    }
  });

  async function login(account: NodeWorkspaceAccount): Promise<string> {
    const response = await request('primary', undefined, 'POST', '/login', {}, {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: account.username },
      password: account.password,
      initial_device_display_name: 'Android message-links fixture',
    });
    const token = response.body['access_token'];
    if (nonEmptyString(token)) {
      // Keep the token for logout before any identity assertion can fail.
      const tokens = primaryTokens.get(account.userId) ?? [];
      tokens.push(token);
      primaryTokens.set(account.userId, tokens);
    }
    assert(
      response.body['user_id'] === account.userId,
      'Message-links API login returned a different user',
    );
    assert(nonEmptyString(token), 'Message-links API login returned no token');
    return token;
  }

  async function primaryToken(account: NodeWorkspaceAccount): Promise<string> {
    const token = primaryTokens.get(account.userId)?.at(-1);
    return token ?? login(account);
  }

  function apiToken(account: NodeWorkspaceAccount): string {
    const token = primaryTokens.get(account.userId)?.at(-1);
    assert(
      apiSessions.has(account.userId) && token,
      'Message-links send requires an apiLogin session for the sender',
    );
    return token;
  }

  function remoteToken(owner: RemoteAccount): string {
    const token = remoteTokens.get(owner.userId);
    assert(token, 'Message-links remote account has no registration session');
    return token;
  }

  async function apiLogin(
    account: NodeWorkspaceAccount,
  ): Promise<{ userId: string }> {
    await login(account);
    apiSessions.add(account.userId);
    return { userId: account.userId };
  }

  async function registerRemote(localpart: string): Promise<RemoteAccount> {
    assert(
      LOCALPART_PATTERN.test(localpart),
      'Message-links remote localpart is not a valid Matrix localpart',
    );
    const response = await request(
      'secondary',
      undefined,
      'POST',
      '/register',
      {},
      {
        auth: { type: 'm.login.dummy' },
        username: localpart,
        password: randomUUID(),
        initial_device_display_name: 'Android message-links fixture',
      },
    );
    const userId = response.body['user_id'];
    const token = response.body['access_token'];
    if (nonEmptyString(userId) && nonEmptyString(token)) {
      remoteTokens.set(userId, token);
    }
    assert(
      userId === `@${localpart}:${serverName}`,
      'Message-links remote registration returned a user outside the secondary server',
    );
    assert(
      nonEmptyString(token),
      'Message-links remote registration returned no token',
    );
    return { userId, localpart };
  }

  async function remoteState(
    token: string,
    roomId: string,
    eventType: string,
  ): Promise<MatrixRecord> {
    return (
      await request('secondary', token, 'GET', `/rooms/{roomId}/state/${eventType}`, {
        roomId,
      })
    ).body;
  }

  async function createRemoteRoom(
    owner: RemoteAccount,
    content: RemoteRoomContent,
  ): Promise<RemoteRoom> {
    const token = remoteToken(owner);
    if (content.aliasLocalpart !== undefined) {
      assert(
        LOCALPART_PATTERN.test(content.aliasLocalpart),
        'Message-links remote alias localpart is not valid',
      );
    }
    const alias =
      content.aliasLocalpart === undefined
        ? undefined
        : `#${content.aliasLocalpart}:${serverName}`;
    // Track before the create: if its response is lost after the secondary
    // committed the Room, the cleanup still resolves and removes it.
    const tracked: RemoteRoomRecord = { ownerId: owner.userId, roomId: undefined, alias };
    remoteRooms.push(tracked);
    let response: MatrixResponse;
    try {
      response = await request(
        'secondary',
        token,
        'POST',
        '/createRoom',
        {},
        {
          name: content.name,
          ...(content.topic === undefined ? {} : { topic: content.topic }),
          preset: content.preset,
          ...(content.visibility ? { visibility: content.visibility } : {}),
          ...(content.aliasLocalpart === undefined
            ? {}
            : { room_alias_name: content.aliasLocalpart }),
        },
      );
    } catch (error) {
      // An HTTP error response means the secondary created nothing, and the alias
      // may belong to another Room: never clean up what this create did not make.
      if (error instanceof MessageLinksHttpError) {
        remoteRooms.splice(remoteRooms.indexOf(tracked), 1);
      }
      throw error;
    }
    const id = stringField(
      response.body,
      'room_id',
      'Message-links remote Room id',
    );
    // Known before the read-back, so a failed read-back is still cleaned up.
    tracked.roomId = id;

    const name = (await remoteState(token, id, 'm.room.name'))['name'];
    assert(name === content.name, 'Message-links remote Room name read-back');
    if (content.topic !== undefined) {
      const topic = (await remoteState(token, id, 'm.room.topic'))['topic'];
      assert(
        topic === content.topic,
        'Message-links remote Room topic read-back',
      );
    }
    const joinRule = stringField(
      await remoteState(token, id, 'm.room.join_rules'),
      'join_rule',
      'Message-links remote Room join rule read-back',
    );
    assert(
      joinRule === (content.preset === 'public_chat' ? 'public' : 'invite'),
      'Message-links remote Room join rule does not match its preset',
    );
    if (alias !== undefined) {
      const resolved = await request(
        'secondary',
        token,
        'GET',
        '/directory/room/{alias}',
        { alias },
      );
      assert(
        resolved.body['room_id'] === id,
        'Message-links remote alias does not resolve to the created Room',
      );
    }
    const directory = await request(
      'secondary',
      token,
      'GET',
      '/directory/list/room/{roomId}',
      { roomId: id },
    );
    const published = directory.body['visibility'] === 'public';
    assert(
      published === (content.visibility === 'public'),
      'Message-links remote Room directory visibility read-back',
    );
    return {
      id,
      ...(alias === undefined ? {} : { alias }),
      joinRule,
      name: content.name,
      ...(content.topic === undefined ? {} : { topic: content.topic }),
      published,
    };
  }

  async function sendMessage(
    account: NodeWorkspaceAccount,
    roomId: string,
    content: { readonly body: string; readonly formattedBody: string },
    txnId: string,
  ): Promise<{ eventId: string }> {
    const token = apiToken(account);
    const response = await request(
      'primary',
      token,
      'PUT',
      '/rooms/{roomId}/send/m.room.message/{txnId}',
      { roomId, txnId },
      {
        msgtype: 'm.text',
        body: content.body,
        format: 'org.matrix.custom.html',
        formatted_body: content.formattedBody,
      },
    );
    return {
      eventId: stringField(
        response.body,
        'event_id',
        'Message-links sent event id',
      ),
    };
  }

  async function sendRoomLink(
    account: NodeWorkspaceAccount,
    roomId: string,
    href: string,
    label: string,
    txnId: string,
  ): Promise<{ eventId: string }> {
    return sendMessage(
      account,
      roomId,
      { body: label, formattedBody: `<a href="${href}">${label}</a>` },
      txnId,
    );
  }

  async function sendFormatted(
    account: NodeWorkspaceAccount,
    roomId: string,
    content: { body: string; formattedBody: string },
    txnId: string,
  ): Promise<{ eventId: string }> {
    return sendMessage(account, roomId, content, txnId);
  }

  async function event(
    account: NodeWorkspaceAccount,
    roomId: string,
    eventId: string,
  ): Promise<{ body: string; format: string; formattedBody: string }> {
    const response = await request(
      'primary',
      await primaryToken(account),
      'GET',
      '/rooms/{roomId}/event/{eventId}',
      { roomId, eventId },
    );
    assert(
      response.body['type'] === 'm.room.message',
      'Message-links event read-back type',
    );
    const content = response.body['content'];
    assert(isRecord(content), 'Message-links event read-back content');
    return {
      body: stringField(content, 'body', 'Message-links event read-back body'),
      format: stringField(
        content,
        'format',
        'Message-links event read-back format',
      ),
      formattedBody: stringField(
        content,
        'formatted_body',
        'Message-links event read-back formatted body',
      ),
    };
  }

  /** Polls until federation answers 200, tolerating only warm-up statuses. */
  async function probe(
    description: string,
    token: string,
    template: string,
    params: Readonly<Record<string, string>>,
    accept: (body: MatrixRecord) => void,
  ): Promise<FederationProbe> {
    const started = Date.now();
    let polls = 0;
    let lastStatus = 0;
    for (;;) {
      const remaining = MESSAGE_LINKS_PROBE_TIMEOUT_MS - (Date.now() - started);
      if (remaining <= 0) {
        throw new Error(
          `Message-links ${description} did not become ready within ${MESSAGE_LINKS_PROBE_TIMEOUT_MS} ms (last HTTP ${lastStatus})`,
        );
      }
      polls += 1;
      const response = await request(
        'primary',
        token,
        'GET',
        template,
        params,
        undefined,
        AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
        MESSAGE_LINKS_PROBE_TOLERATED_STATUSES,
      );
      if (response.status === 200) {
        accept(response.body);
        return { polls, ms: Date.now() - started };
      }
      lastStatus = response.status;
      await pause(
        Math.min(
          MESSAGE_LINKS_PROBE_INTERVAL_MS,
          Math.max(0, MESSAGE_LINKS_PROBE_TIMEOUT_MS - (Date.now() - started)),
        ),
        signal,
      );
    }
  }

  async function awaitAliasFederation(
    account: NodeWorkspaceAccount,
    alias: string,
    expectedRoomId: string,
  ): Promise<FederationProbe> {
    return probe(
      'alias federation',
      await primaryToken(account),
      '/directory/room/{alias}',
      { alias },
      (body) =>
        assert(
          body['room_id'] === expectedRoomId,
          'Message-links federated alias resolved to a different Room',
        ),
    );
  }

  async function awaitProfileFederation(
    account: NodeWorkspaceAccount,
    remoteUserId: string,
  ): Promise<FederationProbe> {
    return probe(
      'profile federation',
      await primaryToken(account),
      '/profile/{userId}',
      { userId: remoteUserId },
      () => undefined,
    );
  }

  async function setRemoteJoinRule(
    owner: RemoteAccount,
    roomId: string,
    rule: 'invite',
  ): Promise<{ status: number; readBack: string }> {
    const token = remoteToken(owner);
    const response = await request(
      'secondary',
      token,
      'PUT',
      '/rooms/{roomId}/state/m.room.join_rules/',
      { roomId },
      { join_rule: rule },
    );
    const readBack = stringField(
      await remoteState(token, roomId, 'm.room.join_rules'),
      'join_rule',
      'Message-links remote join rule read-back',
    );
    assert(
      readBack === rule,
      'Message-links remote join rule read-back does not match the change',
    );
    return { status: response.status, readBack };
  }

  async function remoteJoinRule(
    owner: RemoteAccount,
    roomId: string,
  ): Promise<string> {
    return stringField(
      await remoteState(remoteToken(owner), roomId, 'm.room.join_rules'),
      'join_rule',
      'Message-links remote join rule read',
    );
  }

  async function remoteMembership(
    owner: RemoteAccount,
    roomId: string,
    userId: string,
    parentSignal: AbortSignal = signal,
  ): Promise<MembershipState> {
    const response = await request(
      'secondary',
      remoteToken(owner),
      'GET',
      '/rooms/{roomId}/state/m.room.member/{userId}',
      { roomId, userId },
      undefined,
      parentSignal,
      [404],
    );
    if (response.status === 404) return 'absent';
    const membership = response.body['membership'];
    const state = MEMBERSHIP_STATES.find((candidate) => candidate === membership);
    assert(state, 'Message-links remote membership has an unknown state');
    return state;
  }

  async function leaveLocal(
    account: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<void> {
    await request(
      'primary',
      await primaryToken(account),
      'POST',
      '/rooms/{roomId}/leave',
      { roomId },
      {},
    );
  }

  async function displayName(
    observer: NodeWorkspaceAccount,
    userId: string,
  ): Promise<string | undefined> {
    const response = await request(
      'primary',
      await primaryToken(observer),
      'GET',
      '/profile/{userId}/displayname',
      { userId },
      undefined,
      signal,
      [404],
    );
    if (response.status === 404) return undefined;
    const value = response.body['displayname'];
    return typeof value === 'string' ? value : undefined;
  }

  return {
    apiLogin,
    registerRemote,
    createRemoteRoom,
    sendRoomLink,
    sendFormatted,
    event,
    awaitAliasFederation,
    awaitProfileFederation,
    setRemoteJoinRule,
    remoteJoinRule,
    remoteMembership,
    leaveLocal,
    displayName,
  };
}
