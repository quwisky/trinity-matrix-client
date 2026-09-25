import assert from 'node:assert/strict';
import { createNodeAccount, type NodeAccountOptions } from '../support/node-account.mts';
import type { MatrixTestResources } from '../support/test-resources.mts';
import { SYNAPSE_HTTP } from '../support/synapse/start.mjs';
import { JUMP_TO_DATE_FILLER_COUNT as FILLER_COUNT } from './jump-to-date-contract.mts';
import { JUMP_TO_LATEST_MESSAGE_COUNT } from './jump-to-latest-contract.mts';

export type NodeWorkspaceAccount = Awaited<ReturnType<typeof createNodeAccount>>;

export interface WorkspaceAccountOptions {
  readonly longName?: boolean;
}

export interface WorkspaceRoomContent {
  readonly name: string;
  readonly preset?: string;
  readonly roomVersion?: '9';
  readonly invite?: readonly string[];
  readonly creation_content?: { readonly type: 'm.space' };
  readonly power_level_content_override?: {
    readonly users?: Readonly<Record<string, number>>;
  };
  readonly initial_state?: readonly {
    readonly type: WorkspaceRoomStateEventType;
    readonly state_key: string;
    readonly content: Readonly<Record<string, unknown>>;
  }[];
}

export interface WorkspaceRoom {
  readonly id: string;
  readonly name: string;
}

export interface WorkspaceDirectRoomOptions {
  readonly preset?: 'private_chat' | 'trusted_private_chat';
}

export interface WorkspaceImageEvent {
  readonly eventId: string;
  readonly sender: string;
  readonly msgtype: 'm.image';
}

export interface WorkspaceLocationEvent {
  readonly eventId: string;
  readonly sender: string;
  readonly msgtype: 'm.location';
  readonly body: string | undefined;
  readonly geoUri: string | undefined;
  readonly msc3488Uri: string | undefined;
  readonly assetType: string | undefined;
}

export interface WorkspaceJumpToDateHistory {
  readonly roomId: string;
  readonly roomName: string;
  readonly markerBody: string;
  readonly markerEventId: string;
  readonly fillerEventIds: readonly string[];
  readonly newestFillerBody: string;
  readonly newestFillerEventId: string;
}

export interface WorkspaceJumpToLatestHistory {
  readonly roomId: string;
  readonly roomName: string;
  readonly eventIds: readonly string[];
  readonly newestEventId: string;
  readonly messageCount: number;
}

export interface WorkspaceMessageActionSheetHistory {
  readonly roomId: string;
  readonly roomName: string;
  readonly targetEventId: string;
  readonly targetBody: string;
  readonly oldestFillerEventId: string | null;
  readonly oldestFillerBody: string | null;
  readonly messageCount: number;
}

export interface WorkspaceMessageActionSheetReaction {
  readonly eventIdPresent: boolean;
  readonly senderMatches: boolean;
  readonly targetMatches: boolean;
  readonly annotation: boolean;
  readonly key: string;
  readonly ready: boolean;
}

export type WorkspaceRoomNotificationMode = 'all' | 'mentions' | 'mute';

interface AccessSession {
  readonly account: NodeWorkspaceAccount;
  readonly token: string;
}

interface MatrixRecord {
  readonly [key: string]: unknown;
}

type WorkspaceRoomStateEventType =
  | 'im.vector.modular.widgets'
  | 'm.room.avatar'
  | 'm.room.canonical_alias'
  | 'm.room.encryption'
  | 'm.room.history_visibility'
  | 'm.room.join_rules'
  | 'm.room.name'
  | 'm.room.power_levels'
  | 'm.room.tombstone'
  | 'm.room.topic'
  | 'm.space.parent';

const REQUEST_TIMEOUT_MS = 15_000;
const LONG_ACCOUNT_SUFFIX = '-long-display-account-name';

class MatrixFixtureHttpError extends Error {
  readonly status: number;

  constructor(status: number, method: string, path: string) {
    super(`Matrix fixture ${method} ${path} failed with HTTP ${status}`);
    this.name = 'MatrixFixtureHttpError';
    this.status = status;
  }
}

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
  defaultKeyId(account: NodeWorkspaceAccount): Promise<string | undefined>;
  keyBackupVersion(account: NodeWorkspaceAccount): Promise<string | undefined>;
  masterKey(account: NodeWorkspaceAccount): Promise<string | undefined>;
  createRoom(account: NodeWorkspaceAccount, content: WorkspaceRoomContent): Promise<WorkspaceRoom>;
  setProfileAvatar(account: NodeWorkspaceAccount, png: Uint8Array): Promise<string>;
  createDirectRoom(
    owner: NodeWorkspaceAccount,
    partner: NodeWorkspaceAccount,
    options?: WorkspaceDirectRoomOptions,
  ): Promise<{ readonly id: string }>;
  setDisplayName(account: NodeWorkspaceAccount, name: string): Promise<void>;
  setRoomState(
    account: NodeWorkspaceAccount,
    roomId: string,
    eventType: WorkspaceRoomStateEventType,
    content: MatrixRecord,
    stateKey?: string,
  ): Promise<void>;
  setRoomPower(
    account: NodeWorkspaceAccount,
    roomId: string,
    memberId: string,
    power: number,
  ): Promise<void>;
  invite(account: NodeWorkspaceAccount, roomId: string, invitee: NodeWorkspaceAccount): Promise<void>;
  join(account: NodeWorkspaceAccount, roomId: string): Promise<void>;
  ban(
    owner: NodeWorkspaceAccount,
    roomId: string,
    member: NodeWorkspaceAccount,
    reason: string,
  ): Promise<void>;
  sendMessage(account: NodeWorkspaceAccount, roomId: string, body: string, transactionId: string): Promise<string>;
  createMessageActionSheetHistory(
    account: NodeWorkspaceAccount,
    roomName: string,
    tag: 'a' | 'b' | 'c' | 'v' | 't',
    transactionPrefix: string,
  ): Promise<WorkspaceMessageActionSheetHistory>;
  messageActionSheetReactionEvents(
    account: NodeWorkspaceAccount,
    roomId: string,
    eventId: string,
  ): Promise<readonly WorkspaceMessageActionSheetReaction[]>;
  createJumpToDateHistory(
    account: NodeWorkspaceAccount,
    roomName: string,
    markerBody: string,
    fillerPrefix: string,
    transactionPrefix: string,
  ): Promise<WorkspaceJumpToDateHistory>;
  createJumpToLatestHistory(
    account: NodeWorkspaceAccount,
    roomName: string,
    longBody: string,
    transactionPrefix: string,
  ): Promise<WorkspaceJumpToLatestHistory>;
  setTyping(account: NodeWorkspaceAccount, roomId: string, typing: boolean): Promise<void>;
  reactionEvents(
    observer: NodeWorkspaceAccount,
    roomId: string,
    eventId: string,
  ): Promise<readonly Readonly<Record<string, unknown>>[]>;
  latestImageEvent(
    observer: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<WorkspaceImageEvent | undefined>;
  latestLocationEvents(
    observer: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<readonly WorkspaceLocationEvent[]>;
  sendReadReceipt(
    account: NodeWorkspaceAccount,
    roomId: string,
    eventId: string,
  ): Promise<void>;
  markedUnread(account: NodeWorkspaceAccount, roomId: string): Promise<boolean | undefined>;
  setMarkedUnread(
    account: NodeWorkspaceAccount,
    roomId: string,
    unread: boolean,
  ): Promise<true>;
  setRoomTag(
    account: NodeWorkspaceAccount,
    roomId: string,
    tag: 'm.favourite' | 'm.lowpriority',
  ): Promise<void>;
  setRoomNotificationMode(
    account: NodeWorkspaceAccount,
    roomId: string,
    mode: Exclude<WorkspaceRoomNotificationMode, 'all'>,
  ): Promise<void>;
  roomNotificationMode(
    account: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<WorkspaceRoomNotificationMode>;
  roomTags(
    account: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<Readonly<Record<string, unknown>>>;
  setSpaceChild(
    account: NodeWorkspaceAccount,
    spaceId: string,
    childId: string,
    options?: { readonly order?: string; readonly suggested?: boolean },
  ): Promise<void>;
  spaceChild(
    account: NodeWorkspaceAccount,
    spaceId: string,
    childId: string,
  ): Promise<MatrixRecord | undefined>;
  spaceChildIds(
    account: NodeWorkspaceAccount,
    spaceId: string,
  ): Promise<readonly string[]>;
  roomCreateType(
    account: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<string | undefined>;
  roomMembership(
    observer: NodeWorkspaceAccount,
    roomId: string,
    member: NodeWorkspaceAccount,
  ): Promise<string | undefined>;
  joinedRoomIds(
    account: NodeWorkspaceAccount,
    parentSignal?: AbortSignal,
  ): Promise<readonly string[]>;
  roomState(
    observer: NodeWorkspaceAccount,
    roomId: string,
    eventType: WorkspaceRoomStateEventType,
    stateKey?: string,
  ): Promise<MatrixRecord | undefined>;
  roomEvent(
    observer: NodeWorkspaceAccount,
    roomId: string,
    eventId: string,
  ): Promise<Readonly<Record<string, unknown>>>;
  roomMessages(
    observer: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<Readonly<Record<string, unknown>>>;
  resolveRoomAlias(
    observer: NodeWorkspaceAccount,
    alias: string,
  ): Promise<string | undefined>;
  allowEndedMembershipCleanup(account: NodeWorkspaceAccount, roomId: string): void;
  trackRoomMembership(account: NodeWorkspaceAccount, roomId: string): void;
} {
  const sessions = new Map<string, AccessSession>();
  const accounts = new Map<string, Promise<NodeWorkspaceAccount>>();
  const roomMembers = new Map<string, Set<string>>();
  const endedRoomMembers = new Map<string, Set<string>>();

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
            if (
              action === 'leave' &&
              error instanceof MatrixFixtureHttpError &&
              error.status === 403 &&
              endedRoomMembers.get(roomId)?.has(userId)
            ) {
              continue;
            }
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
      throw new MatrixFixtureHttpError(response.status, method, path);
    }
    return record(await response.json(), `Matrix fixture ${method} ${path} response`);
  }

  async function get(
    session: AccessSession,
    path: string,
    options: { readonly allowNotFound?: boolean } = {},
    parentSignal: AbortSignal = signal,
  ): Promise<unknown | undefined> {
    const response = await fetch(`${SYNAPSE_HTTP}/_matrix/client/v3${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.token}` },
      signal: requestSignal(parentSignal),
    });
    if (options.allowNotFound && response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `Matrix fixture GET ${path} failed with HTTP ${response.status}`,
      );
    }
    return response.json();
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

  async function defaultKeyId(
    owner: NodeWorkspaceAccount,
  ): Promise<string | undefined> {
    const path = `/user/${encodeURIComponent(owner.userId)}/account_data/m.secret_storage.default_key`;
    const value = await get(access(owner), path, { allowNotFound: true });
    if (value === undefined) return undefined;
    const content = record(
      value,
      'Matrix fixture secret-storage default-key response',
    );
    return typeof content['key'] === 'string' ? content['key'] : undefined;
  }

  async function keyBackupVersion(
    owner: NodeWorkspaceAccount,
  ): Promise<string | undefined> {
    const value = await get(access(owner), '/room_keys/version', {
      allowNotFound: true,
    });
    if (value === undefined) return undefined;
    const content = record(value, 'Matrix fixture key-backup response');
    return typeof content['version'] === 'string'
      ? content['version']
      : undefined;
  }

  async function masterKey(
    owner: NodeWorkspaceAccount,
  ): Promise<string | undefined> {
    const content = await request(access(owner), '/keys/query', 'POST', {
      device_keys: { [owner.userId]: [] },
    });
    const masterKeys = record(
      content['master_keys'] ?? {},
      'Matrix fixture cross-signing master-key response',
    );
    const ownerKeys = masterKeys[owner.userId];
    if (ownerKeys === undefined) return undefined;
    const keyDocument = record(
      ownerKeys,
      'Matrix fixture account master-key response',
    );
    const keys = record(
      keyDocument['keys'] ?? {},
      'Matrix fixture account master-key map',
    );
    return Object.keys(keys)[0];
  }

  async function createRoom(
    owner: NodeWorkspaceAccount,
    content: WorkspaceRoomContent,
  ): Promise<WorkspaceRoom> {
    const response = await request(access(owner), '/createRoom', 'POST', {
      name: content.name,
      ...(content.preset ? { preset: content.preset } : {}),
      ...(content.roomVersion
        ? { room_version: content.roomVersion }
        : {}),
      ...(content.invite ? { invite: content.invite } : {}),
      ...(content.creation_content ? { creation_content: content.creation_content } : {}),
      ...(content.power_level_content_override
        ? {
            power_level_content_override:
              content.power_level_content_override,
          }
        : {}),
      ...(content.initial_state ? { initial_state: content.initial_state } : {}),
    });
    const id = stringField(response, 'room_id', 'Matrix fixture room id');
    roomMembers.set(id, new Set([owner.userId]));
    return { id, name: content.name };
  }

  async function setProfileAvatar(
    owner: NodeWorkspaceAccount,
    png: Uint8Array,
  ): Promise<string> {
    const session = access(owner);
    const response = await fetch(
      `${SYNAPSE_HTTP}/_matrix/media/v3/upload?filename=avatar.png`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'Content-Type': 'image/png',
        },
        body: new Blob([Uint8Array.from(png).buffer], { type: 'image/png' }),
        signal: requestSignal(signal),
      },
    );
    if (!response.ok) {
      throw new Error(`Matrix fixture avatar upload failed with HTTP ${response.status}`);
    }
    const uploaded = record(await response.json(), 'Matrix fixture avatar upload response');
    const contentUri = stringField(
      uploaded,
      'content_uri',
      'Matrix fixture avatar upload content uri',
    );
    assert(contentUri.startsWith('mxc://'), 'Matrix fixture avatar upload content uri must be MXC');
    await request(
      session,
      `/profile/${encodeURIComponent(owner.userId)}/avatar_url`,
      'PUT',
      { avatar_url: contentUri },
    );
    return contentUri;
  }

  async function createDirectRoom(
    owner: NodeWorkspaceAccount,
    partner: NodeWorkspaceAccount,
    options: WorkspaceDirectRoomOptions = {},
  ): Promise<{ readonly id: string }> {
    const response = await request(access(owner), '/createRoom', 'POST', {
      preset: options.preset ?? 'private_chat',
      invite: [partner.userId],
      is_direct: true,
    });
    const id = stringField(response, 'room_id', 'Matrix fixture direct room id');
    roomMembers.set(id, new Set([owner.userId]));
    await join(partner, id);
    await request(
      access(owner),
      `/user/${encodeURIComponent(owner.userId)}/account_data/m.direct`,
      'PUT',
      { [partner.userId]: [id] },
    );
    return { id };
  }

  async function setDisplayName(owner: NodeWorkspaceAccount, name: string): Promise<void> {
    await request(
      access(owner),
      `/profile/${encodeURIComponent(owner.userId)}/displayname`,
      'PUT',
      { displayname: name },
    );
  }

  async function setRoomState(
    owner: NodeWorkspaceAccount,
    roomId: string,
    eventType: WorkspaceRoomStateEventType,
    content: MatrixRecord,
    stateKey?: string,
  ): Promise<void> {
    await request(
      access(owner),
      `/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}${stateKey === undefined ? '' : `/${encodeURIComponent(stateKey)}`}`,
      'PUT',
      content,
    );
  }

  async function setRoomPower(
    owner: NodeWorkspaceAccount,
    roomId: string,
    memberId: string,
    power: number,
  ): Promise<void> {
    const path = `/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`;
    const current = record(
      await get(access(owner), path),
      'Matrix fixture room-power response',
    );
    const users = current['users'];
    const currentUsers = users === undefined
      ? {}
      : record(users, 'Matrix fixture room-power users');
    await request(access(owner), path, 'PUT', {
      ...current,
      users: { ...currentUsers, [memberId]: power },
    });
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

  async function ban(
    owner: NodeWorkspaceAccount,
    roomId: string,
    member: NodeWorkspaceAccount,
    reason: string,
  ): Promise<void> {
    assert(
      roomMembers.get(roomId)?.has(member.userId),
      `Cannot ban untracked Matrix fixture membership ${member.userId} in ${roomId}`,
    );
    await request(
      access(owner),
      `/rooms/${encodeURIComponent(roomId)}/ban`,
      'POST',
      { user_id: member.userId, reason },
    );
    allowEndedMembershipCleanup(member, roomId);
  }

  async function sendMessage(
    sender: NodeWorkspaceAccount,
    roomId: string,
    body: string,
    transactionId: string,
  ): Promise<string> {
    const response = await request(
      access(sender),
      `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
      'PUT',
      { msgtype: 'm.text', body },
    );
    return stringField(response, 'event_id', 'Matrix fixture sent-message event id');
  }

  async function createMessageActionSheetHistory(
    owner: NodeWorkspaceAccount,
    roomName: string,
    tag: 'a' | 'b' | 'c' | 'v' | 't',
    transactionPrefix: string,
  ): Promise<WorkspaceMessageActionSheetHistory> {
    const room = await createRoom(owner, { name: roomName, preset: 'private_chat' });
    const eventIds = new Set<string>();
    async function sendReadyMessage(body: string, transactionId: string): Promise<string> {
      const eventId = await sendMessage(owner, room.id, body, transactionId);
      assert(!eventIds.has(eventId), 'Each sheet fixture message has a distinct event id');
      eventIds.add(eventId);
      const event = await roomEvent(owner, room.id, eventId);
      const content = record(event['content'], 'Ready sheet fixture event content');
      assert.equal(event['event_id'], eventId, 'Ready sheet fixture event identity');
      assert.equal(event['type'], 'm.room.message', 'Ready sheet fixture event type');
      assert.equal(event['sender'], owner.userId, 'Ready sheet fixture event sender');
      assert.equal(content['msgtype'], 'm.text', 'Ready sheet fixture message kind');
      assert.equal(content['body'], body, 'Ready sheet fixture exact message body');
      return eventId;
    }
    let oldestFillerEventId: string | null = null;
    let oldestFillerBody: string | null = null;
    if (tag === 'v') {
      for (let index = 0; index < 80; index++) {
        const body = `sheet filler v ${index}`;
        const eventId = await sendReadyMessage(body, `${transactionPrefix}-filler-${index}`);
        if (index === 0) {
          oldestFillerEventId = eventId;
          oldestFillerBody = body;
        }
      }
    }
    const targetBody = `act on me ${transactionPrefix}`;
    const targetEventId = await sendReadyMessage(targetBody, `${transactionPrefix}-target`);
    const messageCount = tag === 'v' ? 81 : 1;
    assert.equal(eventIds.size, messageCount, 'Exact source-owned sheet fixture message count');
    return {
      roomId: room.id, roomName: room.name, targetEventId, targetBody,
      oldestFillerEventId, oldestFillerBody, messageCount,
    };
  }

  async function messageActionSheetReactionEvents(
    account: NodeWorkspaceAccount,
    roomId: string,
    eventId: string,
  ): Promise<readonly WorkspaceMessageActionSheetReaction[]> {
    const events = await reactionEvents(account, roomId, eventId);
    return events.map((event) => {
      const content = record(event['content'], 'Sheet reaction content');
      const value = content['m.relates_to'];
      const relation: MatrixRecord = value && typeof value === 'object' && !Array.isArray(value)
        ? value as MatrixRecord : {};
      const unsigned = event['unsigned'];
      const redacted = unsigned && typeof unsigned === 'object' && 'redacted_because' in unsigned;
      const eventIdPresent = typeof event['event_id'] === 'string' && event['event_id'].length > 0;
      return {
        eventIdPresent,
        senderMatches: event['sender'] === account.userId,
        targetMatches: relation['event_id'] === eventId,
        annotation: relation['rel_type'] === 'm.annotation',
        key: typeof relation['key'] === 'string' ? relation['key'] : '',
        ready: event['type'] === 'm.reaction' && eventIdPresent && !redacted,
      };
    });
  }

  async function createJumpToDateHistory(
    owner: NodeWorkspaceAccount,
    roomName: string,
    markerBody: string,
    fillerPrefix: string,
    transactionPrefix: string,
  ): Promise<WorkspaceJumpToDateHistory> {
    const room = await createRoom(owner, {
      name: roomName,
      preset: 'private_chat',
    });
    const markerEventId = await sendMessage(
      owner,
      room.id,
      markerBody,
      `${transactionPrefix}-marker`,
    );
    const fillerEventIds: string[] = [];
    for (let batch = 0; batch < FILLER_COUNT - 1; batch += 20) {
      const batchSize = Math.min(20, FILLER_COUNT - 1 - batch);
      fillerEventIds.push(
        ...(await Promise.all(
          Array.from({ length: batchSize }, (_, offset) => {
            const index = batch + offset;
            return sendMessage(
              owner,
              room.id,
              `${fillerPrefix} ${index}`,
              `${transactionPrefix}-f${index}`,
            );
          }),
        )),
      );
    }
    const newestIndex = FILLER_COUNT - 1;
    const newestFillerBody = `${fillerPrefix} ${newestIndex}`;
    const newestFillerEventId = await sendMessage(
      owner,
      room.id,
      newestFillerBody,
      `${transactionPrefix}-f${newestIndex}`,
    );
    fillerEventIds.push(newestFillerEventId);
    assert.equal(fillerEventIds.length, FILLER_COUNT);
    assert.equal(
      new Set([markerEventId, ...fillerEventIds]).size,
      FILLER_COUNT + 1,
      'Jump-to-date marker and filler event ids are present and unique',
    );
    return {
      roomId: room.id,
      roomName,
      markerBody,
      markerEventId,
      fillerEventIds,
      newestFillerBody,
      newestFillerEventId,
    };
  }

  async function createJumpToLatestHistory(
    owner: NodeWorkspaceAccount,
    roomName: string,
    longBody: string,
    transactionPrefix: string,
  ): Promise<WorkspaceJumpToLatestHistory> {
    const room = await createRoom(owner, {
      name: roomName,
      preset: 'private_chat',
    });
    const eventIds: string[] = [];
    for (let index = 0; index < JUMP_TO_LATEST_MESSAGE_COUNT; index++) {
      const eventId = await sendMessage(
        owner,
        room.id,
        `Message ${index}: ${longBody}`,
        `${transactionPrefix}-${index}`,
      );
      eventIds.push(eventId);
    }
    assert.equal(eventIds.length, JUMP_TO_LATEST_MESSAGE_COUNT);
    assert.equal(
      new Set(eventIds).size,
      JUMP_TO_LATEST_MESSAGE_COUNT,
      'Jump-to-latest message event ids are present and unique',
    );
    const newestEventId = eventIds.at(-1);
    assert(newestEventId, 'Jump-to-latest has an exact newest event');
    await request(
      access(owner),
      `/rooms/${encodeURIComponent(room.id)}/read_markers`,
      'POST',
      { 'm.fully_read': newestEventId, 'm.read': newestEventId },
    );
    return {
      roomId: room.id,
      roomName,
      eventIds,
      newestEventId,
      messageCount: JUMP_TO_LATEST_MESSAGE_COUNT,
    };
  }

  async function setTyping(
    account: NodeWorkspaceAccount,
    roomId: string,
    typing: boolean,
  ): Promise<void> {
    await request(
      access(account),
      `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(account.userId)}`,
      'PUT',
      typing ? { typing: true, timeout: 30_000 } : { typing: false },
      signal,
    );
  }

  async function reactionEvents(
    observer: NodeWorkspaceAccount,
    roomId: string,
    eventId: string,
  ): Promise<readonly MatrixRecord[]> {
    const response = await fetch(
      `${SYNAPSE_HTTP}/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(eventId)}/m.annotation/m.reaction`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${access(observer).token}` },
        signal: requestSignal(signal),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Matrix fixture reaction relations failed with HTTP ${response.status}`,
      );
    }
    const body = record(
      await response.json(),
      'Matrix fixture reaction-relations response',
    );
    const chunk = body['chunk'];
    assert(Array.isArray(chunk), 'Matrix fixture reaction-relations chunk');
    return chunk.map((event, index) =>
      record(event, `Matrix fixture reaction event ${index}`),
    );
  }

  async function latestImageEvent(
    observer: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<WorkspaceImageEvent | undefined> {
    const value = await get(
      access(observer),
      `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=20`,
    );
    const response = record(value, 'Matrix fixture room-messages response');
    const chunk = response['chunk'];
    assert(Array.isArray(chunk), 'Matrix fixture room-messages chunk');
    for (const [index, candidate] of chunk.entries()) {
      const event = record(candidate, `Matrix fixture room-message event ${index}`);
      const content = record(
        event['content'] ?? {},
        `Matrix fixture room-message content ${index}`,
      );
      if (
        event['type'] === 'm.room.message' &&
        content['msgtype'] === 'm.image'
      ) {
        return {
          eventId: stringField(
            event,
            'event_id',
            'Matrix fixture image-event id',
          ),
          sender: stringField(
            event,
            'sender',
            'Matrix fixture image-event sender',
          ),
          msgtype: 'm.image',
        };
      }
    }
    return undefined;
  }

  async function latestLocationEvents(
    observer: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<readonly WorkspaceLocationEvent[]> {
    const value = await get(
      access(observer),
      `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=20`,
    );
    const response = record(value, 'Matrix fixture room-messages response');
    const chunk = response['chunk'];
    assert(Array.isArray(chunk), 'Matrix fixture room-messages chunk');
    const locations: WorkspaceLocationEvent[] = [];
    for (const [index, candidate] of chunk.entries()) {
      const event = record(
        candidate,
        `Matrix fixture room-message event ${index}`,
      );
      const content = record(
        event['content'] ?? {},
        `Matrix fixture room-message content ${index}`,
      );
      if (
        event['type'] !== 'm.room.message' ||
        content['msgtype'] !== 'm.location'
      ) {
        continue;
      }
      const msc3488Location = record(
        content['org.matrix.msc3488.location'] ?? {},
        `Matrix fixture location content ${index}`,
      );
      const msc3488Asset = record(
        content['org.matrix.msc3488.asset'] ?? {},
        `Matrix fixture location asset ${index}`,
      );
      locations.push({
        eventId: stringField(
          event,
          'event_id',
          'Matrix fixture location-event id',
        ),
        sender: stringField(
          event,
          'sender',
          'Matrix fixture location-event sender',
        ),
        msgtype: 'm.location',
        body:
          typeof content['body'] === 'string' ? content['body'] : undefined,
        geoUri:
          typeof content['geo_uri'] === 'string'
            ? content['geo_uri']
            : undefined,
        msc3488Uri:
          typeof msc3488Location['uri'] === 'string'
            ? msc3488Location['uri']
            : undefined,
        assetType:
          typeof msc3488Asset['type'] === 'string'
            ? msc3488Asset['type']
            : undefined,
      });
    }
    return locations;
  }

  async function sendReadReceipt(
    reader: NodeWorkspaceAccount,
    roomId: string,
    eventId: string,
  ): Promise<void> {
    await request(
      access(reader),
      `/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
      'POST',
      {},
    );
  }

  function markedUnreadPath(account: NodeWorkspaceAccount, roomId: string): string {
    return `/user/${encodeURIComponent(account.userId)}/rooms/${encodeURIComponent(roomId)}/account_data/m.marked_unread`;
  }

  async function markedUnread(
    owner: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<boolean | undefined> {
    const session = access(owner);
    const path = markedUnreadPath(owner, roomId);
    const response = await fetch(`${SYNAPSE_HTTP}/_matrix/client/v3${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.token}` },
      signal: requestSignal(signal),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `Matrix fixture GET ${path} failed with HTTP ${response.status}`,
      );
    }
    const body = record(
      await response.json(),
      'Matrix fixture marked-unread response',
    );
    assert.equal(
      typeof body['unread'],
      'boolean',
      'Matrix fixture marked-unread value is boolean',
    );
    return body['unread'] as boolean;
  }

  async function setMarkedUnread(
    owner: NodeWorkspaceAccount,
    roomId: string,
    unread: boolean,
  ): Promise<true> {
    await request(access(owner), markedUnreadPath(owner, roomId), 'PUT', {
      unread,
    });
    return true;
  }

  async function setRoomTag(
    owner: NodeWorkspaceAccount,
    roomId: string,
    tag: 'm.favourite' | 'm.lowpriority',
  ): Promise<void> {
    await request(
      access(owner),
      `/user/${encodeURIComponent(owner.userId)}/rooms/${encodeURIComponent(roomId)}/tags/${encodeURIComponent(tag)}`,
      'PUT',
      {},
    );
  }

  async function setRoomNotificationMode(
    owner: NodeWorkspaceAccount,
    roomId: string,
    mode: Exclude<WorkspaceRoomNotificationMode, 'all'>,
  ): Promise<void> {
    const kind = mode === 'mentions' ? 'room' : 'override';
    await request(
      access(owner),
      `/pushrules/global/${kind}/${encodeURIComponent(roomId)}`,
      'PUT',
      mode === 'mentions'
        ? { actions: [] }
        : {
            actions: [],
            conditions: [
              { kind: 'event_match', key: 'room_id', pattern: roomId },
            ],
          },
    );
  }

  function pushRuleList(
    global: MatrixRecord,
    kind: 'override' | 'room',
  ): readonly MatrixRecord[] {
    const value = global[kind];
    if (value === undefined) return [];
    assert(Array.isArray(value), `Matrix fixture push-rule ${kind} list`);
    return value.map((entry) =>
      record(entry, `Matrix fixture push-rule ${kind} entry`),
    );
  }

  async function roomNotificationMode(
    owner: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<WorkspaceRoomNotificationMode> {
    const content = record(
      await get(access(owner), '/pushrules/'),
      'Matrix fixture push-rules response',
    );
    const global = record(
      content['global'] ?? {},
      'Matrix fixture global push-rules response',
    );
    const enabled = (rule: MatrixRecord): boolean =>
      rule['rule_id'] === roomId && rule['enabled'] !== false;
    if (pushRuleList(global, 'override').some(enabled)) return 'mute';
    return pushRuleList(global, 'room').some(enabled) ? 'mentions' : 'all';
  }

  async function roomTags(
    owner: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const content = record(
      await get(
        access(owner),
        `/user/${encodeURIComponent(owner.userId)}/rooms/${encodeURIComponent(roomId)}/tags`,
      ),
      'Matrix fixture Room-tags response',
    );
    return record(content['tags'] ?? {}, 'Matrix fixture Room-tags map');
  }

  async function setSpaceChild(
    owner: NodeWorkspaceAccount,
    spaceId: string,
    childId: string,
    options: { readonly order?: string; readonly suggested?: boolean } = {},
  ): Promise<void> {
    await request(
      access(owner),
      `/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`,
      'PUT',
      {
        via: ['localhost'],
        ...(options.order === undefined ? {} : { order: options.order }),
        ...(options.suggested === undefined
          ? {}
          : { suggested: options.suggested }),
      },
    );
  }

  async function spaceChild(
    owner: NodeWorkspaceAccount,
    spaceId: string,
    childId: string,
  ): Promise<MatrixRecord | undefined> {
    const path = `/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`;
    const value = await get(access(owner), path, { allowNotFound: true });
    return value === undefined
      ? undefined
      : record(value, 'Matrix fixture space-child response');
  }

  async function spaceChildIds(
    owner: NodeWorkspaceAccount,
    spaceId: string,
  ): Promise<readonly string[]> {
    const path = `/rooms/${encodeURIComponent(spaceId)}/state`;
    const value = await get(access(owner), path);
    assert(Array.isArray(value), 'Matrix fixture room-state response is an array');
    return value.flatMap((candidate) => {
      const event = record(candidate, 'Matrix fixture room-state event');
      const content = record(
        event['content'],
        'Matrix fixture room-state event content',
      );
      return event['type'] === 'm.space.child' &&
        typeof event['state_key'] === 'string' &&
        Array.isArray(content['via']) &&
        content['via'].length > 0
        ? [event['state_key']]
        : [];
    });
  }

  async function roomCreateType(
    owner: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<string | undefined> {
    const path = `/rooms/${encodeURIComponent(roomId)}/state/m.room.create/`;
    const value = await get(access(owner), path, { allowNotFound: true });
    if (value === undefined) return undefined;
    const content = record(value, 'Matrix fixture room-create response');
    return typeof content['type'] === 'string' ? content['type'] : undefined;
  }

  async function roomMembership(
    observer: NodeWorkspaceAccount,
    roomId: string,
    member: NodeWorkspaceAccount,
  ): Promise<string | undefined> {
    const path = `/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(member.userId)}`;
    const value = await get(access(observer), path, { allowNotFound: true });
    if (value === undefined) return undefined;
    const content = record(value, 'Matrix fixture room-membership response');
    return typeof content['membership'] === 'string'
      ? content['membership']
      : undefined;
  }

  async function roomState(
    observer: NodeWorkspaceAccount,
    roomId: string,
    eventType: WorkspaceRoomStateEventType,
    stateKey?: string,
  ): Promise<MatrixRecord | undefined> {
    const path = `/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}${stateKey === undefined ? '' : `/${encodeURIComponent(stateKey)}`}`;
    const value = await get(access(observer), path, { allowNotFound: true });
    return value === undefined
      ? undefined
      : record(value, 'Matrix fixture room-state response');
  }

  async function roomEvent(
    observer: NodeWorkspaceAccount,
    roomId: string,
    eventId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const value = await get(
      access(observer),
      `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
    );
    return record(value, 'Matrix fixture room-event response');
  }

  /** One raw newest-first `/messages?dir=b&limit=50` page, as the browser reader requests. */
  async function roomMessages(
    observer: NodeWorkspaceAccount,
    roomId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const value = await get(
      access(observer),
      `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`,
    );
    return record(value, 'Matrix fixture room-messages response');
  }

  /** Cleanup may supply its own bounded signal after the invocation is cancelled. */
  async function joinedRoomIds(
    observer: NodeWorkspaceAccount,
    parentSignal: AbortSignal = signal,
  ): Promise<readonly string[]> {
    const content = record(
      await get(access(observer), '/joined_rooms', {}, parentSignal),
      'Matrix fixture joined-rooms response',
    );
    const ids = content['joined_rooms'];
    assert(
      Array.isArray(ids) && ids.every((id) => typeof id === 'string'),
      'Matrix fixture joined-room IDs must be strings',
    );
    return ids;
  }

  async function resolveRoomAlias(
    observer: NodeWorkspaceAccount,
    alias: string,
  ): Promise<string | undefined> {
    const path = `/directory/room/${encodeURIComponent(alias)}`;
    const value = await get(access(observer), path, { allowNotFound: true });
    if (value === undefined) return undefined;
    const content = record(value, 'Matrix fixture room-alias response');
    return typeof content['room_id'] === 'string'
      ? content['room_id']
      : undefined;
  }

  function trackRoomMembership(
    member: NodeWorkspaceAccount,
    roomId: string,
  ): void {
    const members = roomMembers.get(roomId) ?? new Set<string>();
    members.add(member.userId);
    roomMembers.set(roomId, members);
  }

  function allowEndedMembershipCleanup(
    member: NodeWorkspaceAccount,
    roomId: string,
  ): void {
    assert(
      roomMembers.get(roomId)?.has(member.userId),
      `Cannot allow cleanup for untracked Matrix fixture membership ${member.userId} in ${roomId}`,
    );
    const members = endedRoomMembers.get(roomId) ?? new Set<string>();
    members.add(member.userId);
    endedRoomMembers.set(roomId, members);
  }

  return {
    account,
    defaultKeyId,
    keyBackupVersion,
    masterKey,
    createRoom,
    setProfileAvatar,
    createDirectRoom,
    setDisplayName,
    setRoomState,
    setRoomPower,
    invite,
    join,
    ban,
    sendMessage,
    createMessageActionSheetHistory,
    messageActionSheetReactionEvents,
    createJumpToDateHistory,
    createJumpToLatestHistory,
    setTyping,
    reactionEvents,
    latestImageEvent,
    latestLocationEvents,
    sendReadReceipt,
    markedUnread,
    setMarkedUnread,
    setRoomTag,
    setRoomNotificationMode,
    roomNotificationMode,
    roomTags,
    setSpaceChild,
    spaceChild,
    spaceChildIds,
    roomCreateType,
    roomMembership,
    joinedRoomIds,
    roomState,
    roomEvent,
    roomMessages,
    resolveRoomAlias,
    allowEndedMembershipCleanup,
    trackRoomMembership,
  };
}
