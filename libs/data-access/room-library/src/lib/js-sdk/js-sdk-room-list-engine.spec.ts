import { EventEmitter } from 'events';
import { TestBed } from '@angular/core/testing';
import {
  ClientEvent,
  MatrixError,
  SyncState,
  MatrixEventEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { firstValueFrom, tap, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JS_SDK_CLIENTS,
  RoomEncryptionFlags,
} from '@trinity/data-access/matrix-client';
import {
  assertPlainData,
  type EngineResult,
  type VectorDiff,
} from '@trinity/util/matrix';
import type { RoomInfo } from '../room-list-engine';
import { JsSdkRoomListEngine } from './js-sdk-room-list-engine';
import { toRoomInfo } from './room-info';

const ME = '@me:hs';

interface RoomOptions {
  name?: string;
  membership?: string;
  space?: boolean;
  unread?: number;
  highlight?: number;
  activity?: number;
  encrypted?: boolean;
  favourite?: boolean;
  lowPriority?: boolean;
  topic?: string;
  members?: number;
  avatar?: string;
  peerAvatar?: string;
  history?: string;
  markedUnread?: boolean;
  body?: string;
  /** Our own invite event: its sender and `is_direct`. */
  invitedBy?: { userId: string; name: string; isDirect: boolean };
}

/** The slice of a matrix-js-sdk Room that the adapter reads. */
function fakeRoom(roomId: string, opts: RoomOptions = {}) {
  const events = opts.body
    ? [
        {
          getId: () => '$last',
          getType: () => 'm.room.message',
          getContent: () => ({ msgtype: 'm.text', body: opts.body }),
          getOriginalContent: () => ({ msgtype: 'm.text', body: opts.body }),
          getSender: () => '@peer:hs',
          getTs: () => 5,
          replacingEvent: () => null,
          isRedacted: () => false,
          isDecryptionFailure: () => false,
          isEncrypted: () => true,
          isRelation: () => false,
          isState: () => false,
          status: null,
        },
      ]
    : [];
  const timeline = {
    getEvents: () => events,
    getState: () => ({
      getStateEvents: (type: string, stateKey?: string) =>
        type === 'm.room.topic' && opts.topic !== undefined
          ? { getContent: () => ({ topic: opts.topic }) }
          : stateKey === undefined
            ? []
            : null,
    }),
  };
  const room = {
    roomId,
    name: opts.name ?? '',
    tags: {
      ...(opts.favourite ? { 'm.favourite': {} } : {}),
      ...(opts.lowPriority ? { 'm.lowpriority': {} } : {}),
    },
    timeline,
    unread: opts.unread ?? 0,
    isSpaceRoom: () => opts.space ?? false,
    getMyMembership: () => opts.membership ?? 'join',
    getMxcAvatarUrl: () => opts.avatar ?? null,
    getAvatarFallbackMember: () =>
      opts.peerAvatar ? { getMxcAvatarUrl: () => opts.peerAvatar } : undefined,
    getAccountData: (type: string) =>
      type === 'm.marked_unread' && opts.markedUnread
        ? { getContent: () => ({ unread: true }) }
        : undefined,
    getJoinedMemberCount: () => opts.members ?? 1,
    hasEncryptionStateEvent: () => opts.encrypted ?? false,
    getUnreadNotificationCount: (type?: string) =>
      type === 'highlight' ? (opts.highlight ?? 0) : room.unread,
    getLastActiveTimestamp: () => opts.activity ?? 0,
    getThreads: () => [],
    getLiveTimeline: () => room.timeline,
    getHistoryVisibility: () => opts.history ?? 'shared',
    getMember: (userId: string) => {
      const invite = opts.invitedBy;
      if (!invite) return null;
      if (userId === ME) {
        return {
          events: {
            member: {
              getSender: () => invite.userId,
              getContent: () => ({
                membership: 'invite',
                is_direct: invite.isDirect,
              }),
            },
          },
        };
      }
      return userId === invite.userId ? { name: invite.name } : null;
    },
    getMembers: () => [],
  };
  return room;
}

type FakeRoom = ReturnType<typeof fakeRoom>;

class FakeClient extends EventEmitter {
  rooms: FakeRoom[] = [];
  direct: Record<string, string[]> = {};
  accountData: Record<string, object> = {};
  /** The `/versions` answer; null fails the request. */
  versions: {
    versions: string[];
    unstable_features: Record<string, boolean>;
  } | null = { versions: ['v1.12'], unstable_features: {} };
  readonly getVersions = vi.fn(async () => {
    if (!this.versions) throw new TypeError('offline');
    return this.versions;
  });
  readonly setRoomTag = vi.fn(async () => ({}));
  readonly deleteRoomTag = vi.fn(async () => ({}));
  readonly invite = vi.fn(async (): Promise<unknown> => ({}));
  readonly createRoom = vi.fn(async () => ({ room_id: '!new:hs' }));
  readonly leave = vi.fn(async () => ({}));
  readonly setAccountData = vi.fn(
    async (_type: string, _content: object): Promise<unknown> => ({}),
  );
  readonly setRoomAccountData = vi.fn(async () => ({}));
  readonly setRoomReadMarkers = vi.fn(async () => ({}));
  readonly sendReadReceipt = vi.fn(async () => ({}));
  readonly sendStateEvent = vi.fn(async () => ({ event_id: '$written' }));
  readonly joinRoom = vi.fn(async (id: string) => ({
    roomId: id.startsWith('#') ? '!joined:hs' : id,
  }));
  readonly getRoomHierarchy = vi.fn(
    async (): Promise<{ rooms: unknown[]; next_batch?: string }> => ({
      rooms: [],
    }),
  );

  getUserId = (): string => ME;
  getCrypto = () => ({ isEncryptionEnabledInRoom: async () => false });
  getRooms = (): FakeRoom[] => this.rooms;
  getRoom = (id: string): FakeRoom | null =>
    this.rooms.find((r) => r.roomId === id) ?? null;
  getAccountData = (type: string) => {
    const content = type === 'm.direct' ? this.direct : this.accountData[type];
    return content ? { getContent: () => content } : undefined;
  };

  /** Account data arriving over `/sync`. */
  syncAccountData(type: string, content: object): void {
    this.accountData[type] = content;
    this.emit(ClientEvent.AccountData, { getType: () => type });
  }

  totalListeners(): number {
    return this.eventNames().reduce<number>(
      (sum, name) => sum + this.listenerCount(name),
      0,
    );
  }
}

function setup(rooms: FakeRoom[] = []) {
  const client = new FakeClient();
  client.rooms = rooms;
  TestBed.configureTestingModule({
    providers: [
      {
        provide: JS_SDK_CLIENTS,
        useValue: {
          clientFor: (id: string) =>
            id === ME ? (client as unknown as MatrixClient) : null,
        },
      },
    ],
  });
  return { client, engine: TestBed.inject(JsSdkRoomListEngine) };
}

/** Every batch `source` emits, recorded synchronously. */
function record<T>(source: Observable<T>) {
  const batches: T[] = [];
  const subscription = source.subscribe((batch) => batches.push(batch));
  return { batches, subscription };
}

function resetValues(
  batch: readonly VectorDiff<RoomInfo>[] | undefined,
): readonly RoomInfo[] {
  expect(batch).toHaveLength(1);
  const [diff] = batch ?? [];
  if (diff?.op !== 'reset')
    throw new Error(`expected a reset, got ${diff?.op}`);
  return diff.values;
}

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('JsSdkRoomListEngine', () => {
  it('emits its snapshot synchronously on subscribe', () => {
    const { engine } = setup([fakeRoom('!a:hs', { name: 'general' })]);

    const { batches } = record(engine.rooms(ME));

    expect(batches).toHaveLength(1);
    expect(resetValues(batches[0]).map((r) => r.displayName)).toEqual([
      'general',
    ]);
    expect(() => assertPlainData(batches[0])).not.toThrow();
  });

  it('re-emits on Decrypted', async () => {
    const room = fakeRoom('!a:hs');
    const { client, engine } = setup([room]);
    const { batches } = record(engine.rooms(ME));

    room.unread = 3;
    client.emit(MatrixEventEvent.Decrypted, {});
    await tick();

    expect(batches).toHaveLength(2);
    expect(resetValues(batches[1])[0].notificationCount).toBe(3);
  });

  it('re-emits once per microtask for a burst of Receipt and Tags events', async () => {
    const { client, engine } = setup([fakeRoom('!a:hs')]);
    const { batches } = record(engine.rooms(ME));

    client.emit(RoomEvent.Receipt);
    client.emit(RoomEvent.Tags);
    client.emit(RoomEvent.Receipt);
    await tick();

    expect(batches).toHaveLength(2);
  });

  it('re-emits when an older timeline is paged in (builtFrom)', async () => {
    const room = fakeRoom('!a:hs');
    const { client, engine } = setup([room]);
    const { batches } = record(engine.rooms(ME));

    // Built from an empty timeline, so live events alone do not re-read the row...
    client.emit(RoomEvent.Timeline, {}, room, false);
    await tick();
    expect(batches).toHaveLength(1);

    // ...but history paged in at the start does.
    room.timeline = { ...room.timeline };
    client.emit(RoomEvent.Timeline, {}, room, true);
    await tick();
    expect(batches).toHaveLength(2);
  });

  it('re-emits for a member change only when the member is a DM peer', async () => {
    const { client, engine } = setup([fakeRoom('!dm:hs')]);
    client.direct = { '@peer:hs': ['!dm:hs'] };
    const { batches } = record(engine.rooms(ME));

    client.emit(RoomStateEvent.Members, {}, {}, { userId: '@stranger:hs' });
    await tick();
    expect(batches).toHaveLength(1);

    client.emit(RoomStateEvent.Members, {}, {}, { userId: '@peer:hs' });
    await tick();
    expect(batches).toHaveLength(2);
  });

  it('drops a left room and keeps an invited one', () => {
    const { engine } = setup([
      fakeRoom('!joined:hs'),
      fakeRoom('!invited:hs', { membership: 'invite' }),
      fakeRoom('!knocked:hs', { membership: 'knock' }),
      fakeRoom('!left:hs', { membership: 'leave' }),
      fakeRoom('!banned:hs', { membership: 'ban' }),
    ]);

    const { batches } = record(engine.rooms(ME));

    expect(resetValues(batches[0]).map((r) => r.roomId)).toEqual([
      '!joined:hs',
      '!invited:hs',
      '!knocked:hs',
    ]);
  });

  describe('toRoomInfo maps every field', () => {
    const peer = { userId: '@peer:hs', name: 'Peer', isDirect: true };
    const cases: [keyof RoomInfo, RoomOptions, unknown, string?][] = [
      ['roomId', {}, '!r:hs'],
      ['membership', { membership: 'invite' }, 'invite'],
      ['isSpace', { space: true }, true],
      ['displayName', { name: 'general' }, 'general'],
      ['displayName', {}, '!r:hs'],
      ['avatarMxc', { avatar: 'mxc://hs/room' }, 'mxc://hs/room'],
      [
        'avatarMxc',
        { peerAvatar: 'mxc://hs/peer' },
        'mxc://hs/peer',
        '@peer:hs',
      ],
      ['avatarMxc', { peerAvatar: 'mxc://hs/peer' }, null],
      ['topic', { topic: 'Hello' }, 'Hello'],
      ['topic', {}, ''],
      ['joinedMemberCount', { members: 7 }, 7],
      ['directUserId', {}, '@peer:hs', '@peer:hs'],
      ['directUserId', {}, null],
      ['encryption', { encrypted: true }, 'encrypted'],
      ['encryption', {}, 'unknown'],
      ['historyVisibility', { history: 'joined' }, 'joined'],
      ['notificationCount', { unread: 4 }, 4],
      ['highlightCount', { highlight: 2 }, 2],
      ['markedUnread', { markedUnread: true }, true],
      ['recencyStamp', { activity: 99 }, 99],
      ['latestMessage', {}, null],
      [
        'latestMessage',
        { encrypted: true, body: 'hi' },
        { text: 'hi', mark: null },
      ],
      ['favourite', { favourite: true }, true],
      ['lowPriority', { lowPriority: true }, true],
      ['inviter', {}, null],
      [
        'inviter',
        { membership: 'invite', invitedBy: peer },
        { userId: '@peer:hs', displayName: 'Peer', isDirect: true },
      ],
      [
        'avatarMxc',
        { membership: 'invite', invitedBy: peer, peerAvatar: 'mxc://hs/p' },
        'mxc://hs/p',
      ],
      // Stripped state offers the inviter for every invite; only `is_direct` may use it.
      [
        'avatarMxc',
        {
          membership: 'invite',
          invitedBy: { ...peer, isDirect: false },
          peerAvatar: 'mxc://hs/p',
        },
        null,
      ],
    ];

    it.each(cases)('%s from %j', (field, opts, expected, directUserId) => {
      const client = new FakeClient();
      const room = fakeRoom('!r:hs', opts);

      const info = toRoomInfo(
        client as unknown as MatrixClient,
        room as unknown as Room,
        new RoomEncryptionFlags(),
        directUserId ?? null,
      );

      expect(info[field]).toEqual(expected);
      expect(() => assertPlainData(info)).not.toThrow();
    });

    it('reads unencrypted once the crypto store answers', async () => {
      const client = new FakeClient();
      const room = fakeRoom('!r:hs') as unknown as Room;
      const flags = new RoomEncryptionFlags();
      await flags.refresh(client.getCrypto(), room.roomId);

      expect(
        toRoomInfo(client as unknown as MatrixClient, room, flags).encryption,
      ).toBe('unencrypted');
    });
  });

  it('setTag re-emits after the write', async () => {
    // Encrypted by state, so no crypto-store answer re-emits on its own.
    const { client, engine } = setup([fakeRoom('!a:hs', { encrypted: true })]);
    const { batches } = record(engine.rooms(ME));

    const result = await firstValueFrom(
      engine.setTag(ME, '!a:hs', 'lowPriority', true),
    );

    expect(result).toEqual({ ok: true, value: null });
    expect(client.setRoomTag).toHaveBeenCalledWith(
      '!a:hs',
      'm.lowpriority',
      {},
    );
    expect(batches).toHaveLength(2);
  });

  it.each(['M_INVITE_BLOCKED', 'ORG.MATRIX.MSC4155.INVITE_BLOCKED'])(
    'invite maps the MSC4155 errcode %s to invite-blocked',
    async (errcode) => {
      const { client, engine } = setup();
      client.invite.mockRejectedValue(
        new MatrixError({ errcode, error: 'blocked' }, 403),
      );

      const result = await firstValueFrom(engine.invite(ME, '!a:hs', '@b:hs'));

      expect(!result.ok && result.failure.code).toBe('invite-blocked');
      expect(() => assertPlainData(result)).not.toThrow();
    },
  );

  it('invite maps a plain M_FORBIDDEN to request-failed', async () => {
    const { client, engine } = setup();
    client.invite.mockRejectedValue(
      new MatrixError({ errcode: 'M_FORBIDDEN', error: 'no' }, 403),
    );

    const result = await firstValueFrom(engine.invite(ME, '!a:hs', '@b:hs'));

    expect(!result.ok && result.failure.code).toBe('request-failed');
  });

  it('typing names everyone typing, own user included, coalesced', async () => {
    const { client, engine } = setup([fakeRoom('!a:hs')]);
    const { batches } = record(engine.typing(ME));
    const edu = (ids: string[]) => ({ getContent: () => ({ user_ids: ids }) });

    client.emit(RoomMemberEvent.Typing, edu(['@x:hs']), { roomId: '!a:hs' });
    client.emit(RoomMemberEvent.Typing, edu(['@x:hs', ME]), {
      roomId: '!a:hs',
    });
    await tick();

    expect(batches).toEqual([
      {},
      {
        '!a:hs': [
          { userId: '@x:hs', displayName: '@x:hs' },
          { userId: ME, displayName: ME },
        ],
      },
    ]);
  });

  it('unsubscribe removes every listener', () => {
    const { client, engine } = setup([fakeRoom('!a:hs')]);
    const subscriptions = [
      engine.rooms(ME).subscribe(),
      engine.typing(ME).subscribe(),
      engine.directMap(ME).subscribe(),
      engine.inviteBlocking(ME).subscribe(),
    ];
    expect(client.totalListeners()).toBeGreaterThan(0);
    expect(client.listenerCount(ClientEvent.Sync)).toBe(1);

    for (const subscription of subscriptions) subscription.unsubscribe();

    expect(client.totalListeners()).toBe(0);
  });

  it('account-not-live when JS_SDK_CLIENTS has no client', async () => {
    const { engine } = setup();
    const other = '@other:hs';

    const commands: Observable<EngineResult<unknown>>[] = [
      engine.setTag(other, '!r:hs', 'favourite', true),
      engine.setMarkedUnread(other, '!r:hs', true),
      engine.markRead(other, '!r:hs', 'private'),
      engine.leave(other, '!r:hs'),
      engine.createRoom(other, {
        name: 'x',
        topic: null,
        isPublic: false,
        kind: 'room',
        parentSpaceId: null,
      }),
      engine.createDirectMessage(other, '@b:hs'),
      engine.resolveAlias(other, '#x:hs'),
      engine.invite(other, '!r:hs', '@b:hs'),
      engine.join(other, '!r:hs', []),
      engine.spaceHierarchy(other, '!s:hs', { maxPages: null }),
      engine.setSpaceChild(other, '!s:hs', '!r:hs', null),
      engine.setSpaceParent(other, '!r:hs', '!s:hs', ['hs']),
      engine.setInviteBlocking(other, true),
    ];
    for (const command of commands) {
      const result = await firstValueFrom(command);
      expect(!result.ok && result.failure.code).toBe('account-not-live');
    }
    const { batches } = record(engine.rooms(other));
    expect(batches).toEqual([[{ op: 'reset', values: [] }]]);
    expect(record(engine.spaceChildLinks(other, '!s:hs')).batches).toEqual([
      [],
    ]);
    expect(record(engine.inviteBlocking(other)).batches).toEqual([
      { supported: false, blocked: false },
    ]);
  });

  describe('settling a create or leave', () => {
    afterEach(() => vi.useRealTimers());

    /** Subscribes and lets the HTTP call resolve, leaving the command waiting on /sync. */
    async function pending<T>(source: Observable<T>) {
      const replies: T[] = [];
      const subscription = source.subscribe((reply) => replies.push(reply));
      await tick();
      await tick();
      return { replies, subscription };
    }

    it('finishes early on MyMembership', async () => {
      const { client, engine } = setup();
      const { replies } = await pending(
        engine.createRoom(ME, {
          name: 'x',
          topic: null,
          isPublic: false,
          kind: 'room',
          parentSpaceId: null,
        }),
      );
      expect(replies).toEqual([]);

      client.rooms.push(fakeRoom('!new:hs'));
      client.emit(RoomEvent.MyMembership, client.rooms[0], 'join');

      expect(replies).toEqual([{ ok: true, value: { roomId: '!new:hs' } }]);
      expect(client.totalListeners()).toBe(0);
    });

    it('finishes when sync stops', async () => {
      const { client, engine } = setup();
      const { replies } = await pending(
        engine.createRoom(ME, {
          name: 'x',
          topic: null,
          isPublic: false,
          kind: 'room',
          parentSpaceId: null,
        }),
      );

      client.emit(ClientEvent.Sync, SyncState.Syncing);
      expect(replies).toEqual([]);
      client.emit(ClientEvent.Sync, SyncState.Stopped);

      expect(replies).toEqual([{ ok: true, value: { roomId: '!new:hs' } }]);
    });

    it('times out, replies ok and leaves no listener or timer', async () => {
      vi.useFakeTimers();
      const { client, engine } = setup();
      const { replies } = await pending(
        engine.createRoom(ME, {
          name: 'x',
          topic: null,
          isPublic: false,
          kind: 'room',
          parentSpaceId: null,
        }),
      );
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(15_000);

      expect(replies).toEqual([{ ok: true, value: { roomId: '!new:hs' } }]);
      expect(client.totalListeners()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('unsubscribing removes its listeners and timer at once', async () => {
      vi.useFakeTimers();
      const { client, engine } = setup();
      const { subscription } = await pending(
        engine.createRoom(ME, {
          name: 'x',
          topic: null,
          isPublic: false,
          kind: 'room',
          parentSpaceId: null,
        }),
      );
      expect(client.totalListeners()).toBeGreaterThan(0);

      subscription.unsubscribe();

      expect(client.totalListeners()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('createRoom passes the request and waits for join', async () => {
      const { client, engine } = setup();
      const { replies } = await pending(
        engine.createRoom(ME, {
          name: ' x ',
          topic: 'about',
          isPublic: false,
          kind: 'room',
          parentSpaceId: null,
        }),
      );
      expect(client.createRoom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'x', topic: 'about' }),
      );

      client.rooms.push(fakeRoom('!new:hs', { membership: 'invite' }));
      client.emit(ClientEvent.Room, client.rooms[0]);
      expect(replies).toEqual([]);

      client.rooms[0] = fakeRoom('!new:hs');
      client.emit(RoomEvent.MyMembership, client.rooms[0], 'join');
      expect(replies).toHaveLength(1);
    });

    it('leave replies once the room drops out of the list', async () => {
      const { client, engine } = setup([fakeRoom('!a:hs')]);
      const { replies } = await pending(engine.leave(ME, '!a:hs'));
      expect(client.leave).toHaveBeenCalledWith('!a:hs');
      expect(replies).toEqual([]);

      client.rooms[0] = fakeRoom('!a:hs', { membership: 'leave' });
      client.emit(RoomEvent.MyMembership, client.rooms[0], 'leave');

      expect(replies).toEqual([{ ok: true, value: null }]);
    });

    it('an open rooms() subscriber holds the created room when createRoom replies', async () => {
      const { client, engine } = setup();
      const { batches } = record(engine.rooms(ME));
      const seen: string[][] = [];
      await pending(
        engine
          .createRoom(ME, {
            name: 'x',
            topic: null,
            isPublic: false,
            kind: 'room',
            parentSpaceId: null,
          })
          .pipe(
            tap(() =>
              seen.push(resetValues(batches.at(-1)).map((r) => r.roomId)),
            ),
          ),
      );

      client.rooms.push(fakeRoom('!new:hs'));
      client.emit(RoomEvent.MyMembership, client.rooms[0], 'join');

      expect(seen).toEqual([['!new:hs']]);
    });

    it('an open rooms() subscriber has dropped the room when leave replies', async () => {
      const { client, engine } = setup([fakeRoom('!a:hs')]);
      const { batches } = record(engine.rooms(ME));
      const seen: string[][] = [];
      await pending(
        engine
          .leave(ME, '!a:hs')
          .pipe(
            tap(() =>
              seen.push(resetValues(batches.at(-1)).map((r) => r.roomId)),
            ),
          ),
      );

      client.rooms[0] = fakeRoom('!a:hs', { membership: 'leave' });
      client.emit(RoomEvent.MyMembership, client.rooms[0], 'leave');

      expect(seen).toEqual([[]]);
    });

    it('createDirectMessage reuses an invited DM without waiting', async () => {
      const { client, engine } = setup([
        fakeRoom('!dm:hs', { membership: 'invite' }),
      ]);
      client.direct = { '@b:hs': ['!dm:hs'] };

      const { replies } = await pending(
        engine.createDirectMessage(ME, '@b:hs'),
      );

      expect(replies).toEqual([{ ok: true, value: { roomId: '!dm:hs' } }]);
      expect(client.createRoom).not.toHaveBeenCalled();
    });
  });

  it('directMap emits the raw m.direct with left DMs and re-emits on change', () => {
    const { client, engine } = setup([
      fakeRoom('!left:hs', { membership: 'leave' }),
    ]);
    client.direct = {
      '@b:hs': ['!left:hs', 7 as unknown as string],
      '@c:hs': 'bad' as unknown as string[],
    };
    const { batches } = record(engine.directMap(ME));

    client.direct = { ...client.direct, '@d:hs': ['!d:hs'] };
    client.emit(ClientEvent.AccountData, { getType: () => 'm.push_rules' });
    client.emit(ClientEvent.AccountData, { getType: () => 'm.direct' });

    expect(batches).toEqual([
      { '@b:hs': ['!left:hs'] },
      { '@b:hs': ['!left:hs'], '@d:hs': ['!d:hs'] },
    ]);
  });

  it.each([
    ['public', 'm.read'],
    ['private', 'm.read.private'],
  ] as const)(
    'markRead clears the flag and acks the newest confirmed event (%s)',
    async (receipts, receiptType) => {
      const room = fakeRoom('!a:hs', { markedUnread: true });
      const confirmed = { getId: () => '$old', status: null };
      const echo = { getId: () => '~local', status: 'sending' };
      room.timeline = {
        ...room.timeline,
        getEvents: () => [confirmed, echo] as never[],
      };
      const { client, engine } = setup([room]);

      const result = await firstValueFrom(
        engine.markRead(ME, '!a:hs', receipts),
      );

      expect(result).toEqual({ ok: true, value: null });
      expect(client.setRoomAccountData).toHaveBeenCalledWith(
        '!a:hs',
        'm.marked_unread',
        { unread: false },
      );
      expect(client.setRoomReadMarkers).toHaveBeenCalledWith('!a:hs', '$old');
      expect(client.sendReadReceipt).toHaveBeenCalledWith(
        confirmed,
        receiptType,
      );
    },
  );

  describe('invite blocking', () => {
    const STABLE = 'm.invite_permission_config';
    const UNSTABLE = 'org.matrix.msc4380.invite_permission_config';
    const BLOCK = { default_action: 'block' };
    const STABLE_FLAG = {
      versions: ['v1.12'],
      unstable_features: { 'org.matrix.msc4380.stable': true },
    };
    const UNSTABLE_ONLY = {
      versions: ['v1.12'],
      unstable_features: { 'org.matrix.msc4380': true },
    };
    const BOTH = {
      versions: ['v1.18'],
      unstable_features: { 'org.matrix.msc4380': true },
    };

    function blockingSetup(
      versions: FakeClient['versions'],
      accountData: Record<string, object> = {},
    ) {
      const { client, engine } = setup();
      client.versions = versions;
      client.accountData = { ...accountData };
      client.setAccountData.mockImplementation(
        async (type: string, content: object) => {
          client.syncAccountData(type, content);
          return {};
        },
      );
      return { client, engine };
    }

    it('is unsupported synchronously, then supported through the .stable flag', async () => {
      const { engine } = blockingSetup(STABLE_FLAG, { [STABLE]: BLOCK });

      const { batches } = record(engine.inviteBlocking(ME));
      expect(batches).toEqual([{ supported: false, blocked: false }]);
      await tick();

      expect(batches).toEqual([
        { supported: false, blocked: false },
        { supported: true, blocked: true },
      ]);
      expect(() => assertPlainData(batches[1])).not.toThrow();
    });

    it.each([
      ['spec v1.18 or later', { versions: ['v1.19'], unstable_features: {} }],
      ['only the unstable flag', UNSTABLE_ONLY],
    ])('is supported on a server advertising %s', async (_, versions) => {
      const { engine } = blockingSetup(versions);

      const { batches } = record(engine.inviteBlocking(ME));
      await tick();

      expect(batches.at(-1)).toEqual({ supported: true, blocked: false });
    });

    it.each([
      ['neither', { versions: ['v1.12'], unstable_features: {} }],
      ['a failed /versions', null],
    ])('stays unsupported on %s', async (_, versions) => {
      const { engine } = blockingSetup(versions, { [STABLE]: BLOCK });

      const { batches } = record(engine.inviteBlocking(ME));
      await tick();

      expect(batches).toEqual([{ supported: false, blocked: false }]);
    });

    it('asks /versions again on the next account-data event after a failure', async () => {
      const { client, engine } = blockingSetup(null);
      const { batches } = record(engine.inviteBlocking(ME));
      await tick();
      expect(batches).toEqual([{ supported: false, blocked: false }]);

      client.versions = STABLE_FLAG;
      client.syncAccountData(STABLE, {});
      await tick();

      expect(client.getVersions).toHaveBeenCalledTimes(4);
      expect(batches.at(-1)).toEqual({ supported: true, blocked: false });
    });

    it('reads a block from the unstable type on an unstable-only server', async () => {
      const { engine } = blockingSetup(UNSTABLE_ONLY, { [UNSTABLE]: BLOCK });

      const { batches } = record(engine.inviteBlocking(ME));
      await tick();

      expect(batches.at(-1)).toEqual({ supported: true, blocked: true });
    });

    it('follows its account data synced from another device, and only its own', async () => {
      const { client, engine } = blockingSetup(STABLE_FLAG);
      const { batches } = record(engine.inviteBlocking(ME));
      await tick();

      client.syncAccountData('m.push_rules', {});
      client.syncAccountData(STABLE, BLOCK);

      expect(batches).toEqual([
        { supported: false, blocked: false },
        { supported: true, blocked: false },
        { supported: true, blocked: true },
      ]);
    });

    it('blocks through the stable type, is cold, and open subscribers see it first', async () => {
      const { client, engine } = blockingSetup(STABLE_FLAG);
      // No /sync echo: the write itself must re-emit.
      client.setAccountData.mockImplementation(
        async (type: string, content: object) => {
          client.accountData[type] = content;
          return {};
        },
      );
      const { batches } = record(engine.inviteBlocking(ME));
      await tick();

      const command = engine.setInviteBlocking(ME, true);
      expect(client.setAccountData).not.toHaveBeenCalled();
      const result = await firstValueFrom(
        command.pipe(tap(() => expect(batches.at(-1)?.blocked).toBe(true))),
      );

      expect(result).toEqual({ ok: true, value: null });
      expect(client.setAccountData).toHaveBeenCalledExactlyOnceWith(
        STABLE,
        BLOCK,
      );
    });

    it('falls back to the unstable type when only the unstable flag is advertised', async () => {
      const { client, engine } = blockingSetup(UNSTABLE_ONLY);

      await firstValueFrom(engine.setInviteBlocking(ME, true));

      expect(client.setAccountData).toHaveBeenCalledExactlyOnceWith(
        UNSTABLE,
        BLOCK,
      );
    });

    it('allowing clears both the stable type and a block left in the unstable slot', async () => {
      const { client, engine } = blockingSetup(BOTH, {
        [STABLE]: BLOCK,
        [UNSTABLE]: BLOCK,
      });
      const { batches } = record(engine.inviteBlocking(ME));
      await tick();
      expect(batches.at(-1)?.blocked).toBe(true);

      await firstValueFrom(engine.setInviteBlocking(ME, false));

      expect(client.setAccountData).toHaveBeenCalledWith(STABLE, {});
      expect(client.setAccountData).toHaveBeenCalledWith(UNSTABLE, {});
      expect(batches.at(-1)).toEqual({ supported: true, blocked: false });
    });

    it('allowing leaves an unstable slot alone when it holds no block', async () => {
      const { client, engine } = blockingSetup(STABLE_FLAG, {
        [STABLE]: BLOCK,
      });

      await firstValueFrom(engine.setInviteBlocking(ME, false));

      expect(client.setAccountData).toHaveBeenCalledExactlyOnceWith(STABLE, {});
    });

    it.each([
      [
        'has no invite blocking',
        { versions: ['v1.12'], unstable_features: {} },
      ],
      ['fails /versions', null],
    ])('refuses to write where the server %s', async (_, versions) => {
      const { client, engine } = blockingSetup(versions);

      const result = await firstValueFrom(engine.setInviteBlocking(ME, true));

      expect(!result.ok && result.failure.code).toBe('request-failed');
      expect(() => assertPlainData(result)).not.toThrow();
      expect(client.setAccountData).not.toHaveBeenCalled();
    });

    it('maps a failed write to request-failed', async () => {
      const { client, engine } = blockingSetup(STABLE_FLAG);
      client.setAccountData.mockRejectedValue(
        new MatrixError({ errcode: 'M_FORBIDDEN', error: 'no' }, 403),
      );

      const result = await firstValueFrom(engine.setInviteBlocking(ME, true));

      expect(!result.ok && result.failure.code).toBe('request-failed');
    });
  });

  describe('spaces', () => {
    interface ChildEvent {
      readonly stateKey: string;
      readonly content: Record<string, unknown>;
      readonly id?: string;
    }

    /** A space whose live state holds `children` as `m.space.child` events. */
    function space(roomId: string, children: ChildEvent[]) {
      const room = fakeRoom(roomId, { space: true });
      const toEvent = (child: ChildEvent) => ({
        getStateKey: () => child.stateKey,
        getContent: () => child.content,
        getId: () => child.id ?? '$old',
      });
      room.timeline = {
        ...room.timeline,
        getState: () => ({
          getStateEvents: (type: string, stateKey?: string) => {
            const events = type === 'm.space.child' ? children : [];
            if (stateKey === undefined) return events.map(toEvent);
            const match = events.find((e) => e.stateKey === stateKey);
            return match ? toEvent(match) : null;
          },
        }),
      } as never;
      return { room, children };
    }

    const childEvent = (roomId: string) => ({
      getRoomId: () => roomId,
      getType: () => 'm.space.child',
    });

    it('spaceChildLinks emits live links in spec order, synchronously', () => {
      const { room } = space('!s:hs', [
        { stateKey: '!b:hs', content: { via: ['hs'], order: 'b' } },
        { stateKey: '!gone:hs', content: {} },
        { stateKey: '!c:hs', content: { via: ['hs'], order: '\n' } },
        { stateKey: '!a:hs', content: { via: ['hs', 7], suggested: true } },
        { stateKey: '!z:hs', content: { via: ['hs'], order: 'a' } },
      ]);
      const { engine } = setup([room]);

      const { batches } = record(engine.spaceChildLinks(ME, '!s:hs'));

      expect(batches).toEqual([
        [
          { childId: '!z:hs', via: ['hs'], suggested: false, order: 'a' },
          { childId: '!b:hs', via: ['hs'], suggested: false, order: 'b' },
          { childId: '!a:hs', via: ['hs'], suggested: true, order: '' },
          { childId: '!c:hs', via: ['hs'], suggested: false, order: '' },
        ],
      ]);
      expect(() => assertPlainData(batches[0])).not.toThrow();
    });

    it('spaceChildLinks re-emits once per microtask for its own space only', async () => {
      const { room, children } = space('!s:hs', []);
      const { client, engine } = setup([room]);
      const { batches, subscription } = record(
        engine.spaceChildLinks(ME, '!s:hs'),
      );

      children.push({ stateKey: '!a:hs', content: { via: ['hs'] } });
      client.emit(RoomStateEvent.Events, childEvent('!other:hs'));
      await tick();
      expect(batches).toHaveLength(1);
      client.emit(RoomStateEvent.Events, childEvent('!s:hs'));
      client.emit(RoomStateEvent.Events, childEvent('!s:hs'));
      await tick();

      expect(batches.map((links) => links.length)).toEqual([0, 1]);
      subscription.unsubscribe();
      expect(client.totalListeners()).toBe(0);
    });

    it('setSpaceChild writes the link and replies once sync holds it, open subscribers first', async () => {
      const { room, children } = space('!s:hs', []);
      const { client, engine } = setup([room]);
      const { batches } = record(engine.spaceChildLinks(ME, '!s:hs'));
      const replies: unknown[] = [];
      engine
        .setSpaceChild(ME, '!s:hs', '!a:hs', {
          via: ['hs'],
          suggested: true,
          order: 'm',
        })
        .pipe(tap(() => replies.push(batches.at(-1))))
        .subscribe();
      await tick();
      expect(client.sendStateEvent).toHaveBeenCalledWith(
        '!s:hs',
        'm.space.child',
        { via: ['hs'], suggested: true, order: 'm' },
        '!a:hs',
      );

      children.push({
        stateKey: '!a:hs',
        content: { via: ['hs'], suggested: true, order: 'm' },
      });
      client.emit(RoomStateEvent.Events, childEvent('!s:hs'));
      expect(replies).toEqual([]);
      children[0] = { ...children[0], id: '$written' };
      client.emit(RoomStateEvent.Events, childEvent('!s:hs'));

      expect(replies).toEqual([
        [{ childId: '!a:hs', via: ['hs'], suggested: true, order: 'm' }],
      ]);
    });

    it('setSpaceChild null sends the empty content that removes the link', async () => {
      const { client, engine } = setup();
      engine.setSpaceChild(ME, '!s:hs', '!a:hs', null).subscribe();
      await tick();

      expect(client.sendStateEvent).toHaveBeenCalledWith(
        '!s:hs',
        'm.space.child',
        {},
        '!a:hs',
      );
    });

    it('createRoom of a space marks it a space and leaves it unencrypted', async () => {
      const { client, engine } = setup();
      engine
        .createRoom(ME, {
          name: ' s ',
          topic: null,
          isPublic: false,
          kind: 'space',
          parentSpaceId: null,
        })
        .subscribe();
      await tick();

      const [request] = client.createRoom.mock.calls[0] as unknown as [
        Record<string, unknown>,
      ];
      expect(request).toMatchObject({
        creation_content: { type: 'm.space' },
        name: 's',
      });
      expect(request).not.toHaveProperty('initial_state');
      expect(client.sendStateEvent).not.toHaveBeenCalled();
    });

    it('createRoom with parentSpaceId links child then parent through our server', async () => {
      const { room, children } = space('!s:hs', []);
      const { client, engine } = setup([room]);
      const replies: unknown[] = [];
      engine
        .createRoom(ME, {
          name: 'x',
          topic: null,
          isPublic: false,
          kind: 'room',
          parentSpaceId: '!s:hs',
        })
        .subscribe((reply) => replies.push(reply));
      await tick();
      await tick();
      expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
      expect(client.sendStateEvent).toHaveBeenCalledWith(
        '!s:hs',
        'm.space.child',
        { via: ['hs'], suggested: true },
        '!new:hs',
      );

      children.push({
        stateKey: '!new:hs',
        content: { via: ['hs'], suggested: true },
        id: '$written',
      });
      client.emit(RoomStateEvent.Events, childEvent('!s:hs'));
      await tick();
      await tick();
      expect(client.sendStateEvent).toHaveBeenLastCalledWith(
        '!new:hs',
        'm.space.parent',
        { via: ['hs'], canonical: true },
        '!s:hs',
      );
      expect(replies).toEqual([]);

      client.rooms.push(fakeRoom('!new:hs'));
      client.emit(RoomEvent.MyMembership, client.rooms.at(-1), 'join');
      expect(replies).toEqual([{ ok: true, value: { roomId: '!new:hs' } }]);
    });

    it('setSpaceParent writes a canonical parent', async () => {
      const { client, engine } = setup();

      const result = await firstValueFrom(
        engine.setSpaceParent(ME, '!c:hs', '!s:hs', ['a', 'b']),
      );

      expect(result).toEqual({ ok: true, value: null });
      expect(client.sendStateEvent).toHaveBeenCalledWith(
        '!c:hs',
        'm.space.parent',
        { via: ['a', 'b'], canonical: true },
        '!s:hs',
      );
    });

    it.each([
      [['a', 'b'], { viaServers: ['a', 'b'] }],
      [[], undefined],
    ])(
      'join routes through %j and replies once joined',
      async (via, options) => {
        const { client, engine } = setup();
        const replies: unknown[] = [];
        engine.join(ME, '#x:hs', via).subscribe((reply) => replies.push(reply));
        await tick();
        await tick();
        expect(client.joinRoom).toHaveBeenCalledWith('#x:hs', options);
        expect(replies).toEqual([]);

        client.rooms.push(fakeRoom('!joined:hs'));
        client.emit(RoomEvent.MyMembership, client.rooms[0], 'join');

        expect(replies).toEqual([
          { ok: true, value: { roomId: '!joined:hs' } },
        ]);
      },
    );

    const hierarchyRoom = (roomId: string, extra = {}) => ({
      room_id: roomId,
      num_joined_members: 2,
      world_readable: false,
      guest_can_join: false,
      children_state: [],
      ...extra,
    });

    it('spaceHierarchy lists the space and its child with the link', async () => {
      const { client, engine } = setup();
      client.getRoomHierarchy.mockResolvedValueOnce({
        rooms: [
          hierarchyRoom('!s:hs', {
            name: 'Space',
            room_type: 'm.space',
            join_rule: 'invite',
            children_state: [
              { state_key: '!a:hs', content: { via: ['hs'], order: 'x' } },
              { state_key: '', content: { via: ['hs'] } },
            ],
          }),
          hierarchyRoom('!a:hs', {
            canonical_alias: '#a:hs',
            topic: 'about',
            avatar_url: 'mxc://hs/a',
          }),
        ],
      });

      const result = await firstValueFrom(
        engine.spaceHierarchy(ME, '!s:hs', { maxPages: null }),
      );

      expect(() => assertPlainData(result)).not.toThrow();
      expect(client.getRoomHierarchy).toHaveBeenCalledWith(
        '!s:hs',
        100,
        1,
        false,
        undefined,
      );
      expect(result).toEqual({
        ok: true,
        value: [
          {
            roomId: '!s:hs',
            name: 'Space',
            canonicalAlias: null,
            topic: null,
            avatarMxc: null,
            joinedMemberCount: 2,
            joinRule: 'invite',
            isSpace: true,
            childrenState: [
              { childId: '!a:hs', via: ['hs'], suggested: false, order: 'x' },
            ],
          },
          {
            roomId: '!a:hs',
            name: null,
            canonicalAlias: '#a:hs',
            topic: 'about',
            avatarMxc: 'mxc://hs/a',
            joinedMemberCount: 2,
            joinRule: null,
            isSpace: false,
            childrenState: [],
          },
        ],
      });
    });

    it('spaceHierarchy follows next_batch up to maxPages', async () => {
      const { client, engine } = setup();
      client.getRoomHierarchy.mockImplementation(async () => ({
        rooms: [
          hierarchyRoom(`!${client.getRoomHierarchy.mock.calls.length}:hs`),
        ],
        next_batch: `t${client.getRoomHierarchy.mock.calls.length}`,
      }));

      const result = await firstValueFrom(
        engine.spaceHierarchy(ME, '!s:hs', { maxPages: 3 }),
      );

      expect(result.ok && result.value.map((e) => e.roomId)).toEqual([
        '!1:hs',
        '!2:hs',
        '!3:hs',
      ]);
      expect(client.getRoomHierarchy.mock.calls.map((c) => c.at(4))).toEqual([
        undefined,
        't1',
        't2',
      ]);
    });

    it('spaceHierarchy stops at a repeated token with request-failed', async () => {
      const { client, engine } = setup();
      client.getRoomHierarchy
        .mockResolvedValueOnce({
          rooms: [hierarchyRoom('!s:hs'), hierarchyRoom('!a:hs')],
          next_batch: 'again',
        })
        .mockResolvedValue({ rooms: [], next_batch: 'again' });

      const result = await firstValueFrom(
        engine.spaceHierarchy(ME, '!s:hs', { maxPages: null }),
      );

      expect(client.getRoomHierarchy).toHaveBeenCalledTimes(2);
      expect(!result.ok && result.failure.code).toBe('request-failed');
    });
  });
});
