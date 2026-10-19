import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { RoomEvent, RoomStateEvent } from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { describe, expect, it } from 'vitest';
import { RoomsInCommonService } from './rooms-in-common.service';
import { RoomLibraryService, type RoomSummary } from './room-library.service';
import { SpacesService } from './spaces.service';

const ME = '@me:hs';
const OTHER_ACCOUNT = '@alt:hs';
const PERSON = '@bob:hs';

type Handler = (...args: unknown[]) => void;

function fakeRoom(opts: {
  roomId: string;
  name: string;
  members: Record<string, string>;
  space?: boolean;
  membership?: string;
}) {
  return {
    roomId: opts.roomId,
    name: opts.name,
    tags: {},
    members: opts.members,
    isSpaceRoom: () => opts.space ?? false,
    getMyMembership: () => opts.membership ?? 'join',
    getMember: (userId: string) =>
      opts.members[userId]
        ? { userId, membership: opts.members[userId] }
        : null,
    getMxcAvatarUrl: () => null,
    getAccountData: () => undefined,
    getJoinedMemberCount: () =>
      Object.values(opts.members).filter((m) => m === 'join').length,
    hasEncryptionStateEvent: () => false,
    getUnreadNotificationCount: () => 0,
    getLastActiveTimestamp: () => 0,
    getLiveTimeline: () => ({
      getEvents: () => [],
      getState: () => ({ getStateEvents: () => null }),
    }),
  };
}

function fakeClient(
  rooms: ReturnType<typeof fakeRoom>[],
  direct: Record<string, string[]> = {},
) {
  const handlers = new Map<string, Set<Handler>>();
  return {
    getRooms: () => rooms,
    getAccountData: (type: string) =>
      type === 'm.direct' ? { getContent: () => direct } : undefined,
    on: (event: string, handler: Handler) => {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
    },
    off: (event: string, handler: Handler) =>
      handlers.get(event)?.delete(handler),
    emit: (event: string, ...args: unknown[]) =>
      handlers.get(event)?.forEach((handler) => handler(...args)),
  };
}

function setup(clients: Record<string, ReturnType<typeof fakeClient>>) {
  const activeUserId = signal<string | null>(ME);
  const prepared = signal<ReadonlySet<string>>(new Set(Object.keys(clients)));
  const accountIds = signal<readonly string[]>(Object.keys(clients));
  const rooms = signal<RoomSummary[]>([]);
  TestBed.configureTestingModule({
    providers: [
      {
        provide: MatrixClientService,
        useValue: {
          activeUserId,
          accountIds,
          roomsPrepared: (id: string) => prepared().has(id),
          clientFor: (id: string) => clients[id] ?? null,
        },
      },
      { provide: RoomLibraryService, useValue: { rooms } },
      { provide: SpacesService, useValue: { spaces: signal([]) } },
    ],
  });
  const svc = TestBed.inject(RoomsInCommonService);
  return { svc, activeUserId, prepared, rooms };
}

const ids = (list: readonly { id: string }[] | null) =>
  list?.map((room) => room.id) ?? null;

describe('RoomsInCommonService', () => {
  it('lists joined rooms where the person is also joined, excluding the current room', () => {
    const client = fakeClient([
      fakeRoom({ roomId: '!a', name: 'A', members: { [PERSON]: 'join' } }),
      fakeRoom({ roomId: '!b', name: 'B', members: { [PERSON]: 'join' } }),
      fakeRoom({ roomId: '!c', name: 'C', members: {} }),
    ]);
    const { svc } = setup({ [ME]: client });

    const common = svc.roomsInCommon(PERSON, '!a')();

    expect(common).toEqual([
      {
        id: '!b',
        accountId: ME,
        name: 'B',
        initial: 'B',
        avatarMxc: null,
        kind: 'room',
        memberCount: 1,
      },
    ]);
  });

  it('ignores rooms where the person is invited or has left', () => {
    const client = fakeClient([
      fakeRoom({ roomId: '!a', name: 'A', members: { [PERSON]: 'invite' } }),
      fakeRoom({ roomId: '!b', name: 'B', members: { [PERSON]: 'leave' } }),
      fakeRoom({
        roomId: '!c',
        name: 'C',
        members: { [PERSON]: 'join' },
        membership: 'leave',
      }),
    ]);
    const { svc } = setup({ [ME]: client });

    expect(svc.roomsInCommon(PERSON, '!x')()).toEqual([]);
  });

  it('marks direct rooms and spaces', () => {
    const client = fakeClient(
      [
        fakeRoom({ roomId: '!dm', name: 'Bob', members: { [PERSON]: 'join' } }),
        fakeRoom({
          roomId: '!space',
          name: 'Space',
          members: { [PERSON]: 'join' },
          space: true,
        }),
        fakeRoom({
          roomId: '!room',
          name: 'Room',
          members: { [PERSON]: 'join' },
        }),
      ],
      { [PERSON]: ['!dm'] },
    );
    const { svc } = setup({ [ME]: client });

    const kinds = svc
      .roomsInCommon(PERSON, '!x')()
      ?.map((room) => [room.id, room.kind]);

    expect(kinds).toEqual([
      ['!dm', 'direct'],
      ['!room', 'room'],
      ['!space', 'space'],
    ]);
  });

  it('updates when the person leaves a shared room', () => {
    const shared = fakeRoom({
      roomId: '!b',
      name: 'B',
      members: { [PERSON]: 'join' },
    });
    const client = fakeClient([shared]);
    const { svc } = setup({ [ME]: client });
    const common = svc.roomsInCommon(PERSON, '!a');
    expect(ids(common())).toEqual(['!b']);
    TestBed.tick();

    shared.members[PERSON] = 'leave';
    client.emit(RoomStateEvent.Members, {}, {}, { userId: PERSON });

    expect(common()).toEqual([]);
  });

  it('updates when this account leaves a shared room', () => {
    let membership = 'join';
    const shared = {
      ...fakeRoom({ roomId: '!b', name: 'B', members: { [PERSON]: 'join' } }),
      getMyMembership: () => membership,
    };
    const client = fakeClient([shared]);
    const { svc } = setup({ [ME]: client });
    const common = svc.roomsInCommon(PERSON, '!a');
    expect(ids(common())).toEqual(['!b']);
    TestBed.tick();

    membership = 'leave';
    client.emit(RoomEvent.MyMembership, shared, 'leave');

    expect(common()).toEqual([]);
  });

  it('is null before the room list is ready and after an account switch', () => {
    const client = fakeClient([
      fakeRoom({ roomId: '!b', name: 'B', members: { [PERSON]: 'join' } }),
    ]);
    const { svc, prepared, activeUserId } = setup({ [ME]: client });
    prepared.set(new Set());
    const common = svc.roomsInCommon(PERSON, '!a');

    expect(common()).toBeNull();
    prepared.set(new Set([ME]));
    expect(ids(common())).toEqual(['!b']);

    activeUserId.set(OTHER_ACCOUNT);
    expect(common()).toBeNull();
  });

  it('reads the named account rather than the active one', () => {
    const active = fakeClient([
      fakeRoom({ roomId: '!a', name: 'A', members: { [PERSON]: 'join' } }),
    ]);
    const other = fakeClient([
      fakeRoom({ roomId: '!b', name: 'B', members: { [PERSON]: 'join' } }),
    ]);
    const { svc } = setup({ [ME]: active, [OTHER_ACCOUNT]: other });

    const common = svc.roomsInCommon(PERSON, '!x', OTHER_ACCOUNT)();

    expect(common?.map((room) => [room.id, room.accountId])).toEqual([
      ['!b', OTHER_ACCOUNT],
    ]);
  });

  it('orders by name, case-insensitively', () => {
    const client = fakeClient([
      fakeRoom({
        roomId: '!c',
        name: 'charlie',
        members: { [PERSON]: 'join' },
      }),
      fakeRoom({ roomId: '!a', name: 'Alpha', members: { [PERSON]: 'join' } }),
      fakeRoom({ roomId: '!b', name: 'bravo', members: { [PERSON]: 'join' } }),
    ]);
    const { svc } = setup({ [ME]: client });

    expect(ids(svc.roomsInCommon(PERSON, '!x')())).toEqual(['!a', '!b', '!c']);
  });

  it('caches the signal per user, excluded room and account', () => {
    const { svc } = setup({ [ME]: fakeClient([]) });

    expect(svc.roomsInCommon(PERSON, '!a')).toBe(
      svc.roomsInCommon(PERSON, '!a'),
    );
    expect(svc.roomsInCommon(PERSON, '!a')).not.toBe(
      svc.roomsInCommon(PERSON, '!a', OTHER_ACCOUNT),
    );
  });
});
