import { EventEmitter } from 'events';
import { TestBed } from '@angular/core/testing';
import {
  ClientEvent,
  MatrixError,
  MatrixEventEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { firstValueFrom, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import {
  RoomEncryptionFlags,
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
  readonly setRoomTag = vi.fn(async () => ({}));
  readonly deleteRoomTag = vi.fn(async () => ({}));
  readonly invite = vi.fn(async (): Promise<unknown> => ({}));

  getUserId = (): string => ME;
  getCrypto = () => ({ isEncryptionEnabledInRoom: async () => false });
  getRooms = (): FakeRoom[] => this.rooms;
  getRoom = (id: string): FakeRoom | null =>
    this.rooms.find((r) => r.roomId === id) ?? null;
  getAccountData = (type: string) =>
    type === 'm.direct' ? { getContent: () => this.direct } : undefined;

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
    'invite maps an MSC4380 %s rejection to invite-blocked',
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
      engine.createRoom(other, { name: 'x', topic: null, isPublic: false }),
      engine.createDirectMessage(other, '@b:hs'),
      engine.resolveAlias(other, '#x:hs'),
      engine.invite(other, '!r:hs', '@b:hs'),
    ];
    for (const command of commands) {
      const result = await firstValueFrom(command);
      expect(!result.ok && result.failure.code).toBe('account-not-live');
    }
    const { batches } = record(engine.rooms(other));
    expect(batches).toEqual([[{ op: 'reset', values: [] }]]);
  });
});
