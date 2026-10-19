import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { RoomEvent, RoomStateEvent } from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomsInCommonService } from './rooms-in-common.service';
import { RoomLibraryService, type RoomSummary } from './room-library.service';

const ME = '@me:hs';
const OTHER_ACCOUNT = '@alt:hs';
const PERSON = '@bob:hs';
const UNSTABLE_FLAG = 'uk.half-shot.msc2666.query_mutual_rooms';
const STABLE_PATH = '/_matrix/client/v1/mutual_rooms';
const UNSTABLE_PATH =
  '/_matrix/client/unstable/uk.half-shot.msc2666/user/mutual_rooms';

type Handler = (...args: unknown[]) => void;
type Page = { joined: string[]; next_batch?: string };

function fakeRoom(opts: {
  roomId: string;
  name: string;
  members?: Record<string, string>;
  space?: boolean;
  membership?: string;
}) {
  const members = opts.members ?? {};
  return {
    roomId: opts.roomId,
    name: opts.name,
    members,
    isSpaceRoom: () => opts.space ?? false,
    getMyMembership: () => opts.membership ?? 'join',
    getMember: (userId: string) =>
      members[userId] ? { userId, membership: members[userId] } : null,
    getMxcAvatarUrl: () => null,
    getJoinedMemberCount: () =>
      Object.values(members).filter((m) => m === 'join').length,
  };
}

function fakeClient(
  rooms: ReturnType<typeof fakeRoom>[],
  opts: {
    direct?: Record<string, string[]>;
    versions?: string[];
    features?: Record<string, boolean>;
    pages?: Page[] | Error;
    /** `/versions` never answers. */
    hang?: boolean;
  } = {},
) {
  const handlers = new Map<string, Set<Handler>>();
  const pages = opts.pages;
  const authedRequest = vi.fn(async (): Promise<Page> => {
    if (pages instanceof Error) throw pages;
    return pages?.[authedRequest.mock.calls.length - 1] ?? { joined: [] };
  });
  return {
    getRooms: () => rooms,
    getAccountData: (type: string) =>
      type === 'm.direct' ? { getContent: () => opts.direct ?? {} } : undefined,
    getVersions: () =>
      opts.hang
        ? new Promise<never>(() => undefined)
        : Promise.resolve({
            versions: opts.versions ?? ['v1.11'],
            unstable_features: opts.features ?? {},
          }),
    http: { authedRequest },
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
    ],
  });
  const svc = TestBed.inject(RoomsInCommonService);
  return { svc, activeUserId, prepared, accountIds };
}

/** Let the `/versions` probe and any mutual-rooms request settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const ids = (list: readonly { id: string }[] | null) =>
  list?.map((room) => room.id) ?? null;

afterEach(() => vi.useRealTimers());

describe('RoomsInCommonService', () => {
  it('lists joined rooms where the person is also joined, excluding the current room', async () => {
    const client = fakeClient([
      fakeRoom({ roomId: '!a', name: 'A', members: { [PERSON]: 'join' } }),
      fakeRoom({ roomId: '!b', name: 'B', members: { [PERSON]: 'join' } }),
      fakeRoom({ roomId: '!c', name: 'C' }),
    ]);
    const { svc } = setup({ [ME]: client });
    const common = svc.roomsInCommon(PERSON, '!a');
    await settle();

    expect(common()).toEqual([
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

  it('ignores rooms where the person is invited or has left', async () => {
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
    const common = svc.roomsInCommon(PERSON, '!x');
    await settle();

    expect(common()).toEqual([]);
  });

  it('marks direct rooms and spaces', async () => {
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
      { direct: { [PERSON]: ['!dm'] } },
    );
    const { svc } = setup({ [ME]: client });
    const common = svc.roomsInCommon(PERSON, '!x');
    await settle();

    expect(common()?.map((room) => [room.id, room.kind])).toEqual([
      ['!dm', 'direct'],
      ['!room', 'room'],
      ['!space', 'space'],
    ]);
  });

  it('updates when the person leaves a shared room', async () => {
    const shared = fakeRoom({
      roomId: '!b',
      name: 'B',
      members: { [PERSON]: 'join' },
    });
    const client = fakeClient([shared]);
    const { svc } = setup({ [ME]: client });
    const common = svc.roomsInCommon(PERSON, '!a');
    await settle();
    expect(ids(common())).toEqual(['!b']);
    TestBed.tick();

    shared.members[PERSON] = 'leave';
    client.emit(RoomStateEvent.Members, {}, {}, { userId: PERSON });

    expect(common()).toEqual([]);
  });

  it('updates when this account leaves a shared room', async () => {
    let membership = 'join';
    const shared = {
      ...fakeRoom({ roomId: '!b', name: 'B', members: { [PERSON]: 'join' } }),
      getMyMembership: () => membership,
    };
    const client = fakeClient([shared]);
    const { svc } = setup({ [ME]: client });
    const common = svc.roomsInCommon(PERSON, '!a');
    await settle();
    expect(ids(common())).toEqual(['!b']);
    TestBed.tick();

    membership = 'leave';
    client.emit(RoomEvent.MyMembership, shared, 'leave');

    expect(common()).toEqual([]);
  });

  it('follows a room rename', async () => {
    const shared = fakeRoom({
      roomId: '!b',
      name: 'B',
      members: { [PERSON]: 'join' },
    });
    const client = fakeClient([shared]);
    const { svc } = setup({ [ME]: client });
    const common = svc.roomsInCommon(PERSON, '!a');
    await settle();
    TestBed.tick();

    shared.name = 'Renamed';
    client.emit(RoomEvent.Name, shared);

    expect(common()?.[0].name).toBe('Renamed');
  });

  it('is null before the room list is ready and after an account switch', async () => {
    const shared = () =>
      fakeRoom({ roomId: '!b', name: 'B', members: { [PERSON]: 'join' } });
    const { svc, prepared, activeUserId } = setup({
      [ME]: fakeClient([shared()]),
      [OTHER_ACCOUNT]: fakeClient([shared()]),
    });
    prepared.set(new Set([OTHER_ACCOUNT]));
    const common = svc.roomsInCommon(PERSON, '!a');
    await settle();

    expect(common()).toBeNull();
    prepared.set(new Set([ME, OTHER_ACCOUNT]));
    expect(ids(common())).toEqual(['!b']);

    activeUserId.set(OTHER_ACCOUNT);
    expect(common()).toBeNull();
  });

  it('is null until the first answer arrives', () => {
    const client = fakeClient([
      fakeRoom({ roomId: '!b', name: 'B', members: { [PERSON]: 'join' } }),
    ]);
    const { svc } = setup({ [ME]: client });

    expect(svc.roomsInCommon(PERSON, '!a')()).toBeNull();
  });

  it('reads the named account rather than the active one', async () => {
    const active = fakeClient([
      fakeRoom({ roomId: '!a', name: 'A', members: { [PERSON]: 'join' } }),
    ]);
    const other = fakeClient([
      fakeRoom({ roomId: '!b', name: 'B', members: { [PERSON]: 'join' } }),
    ]);
    const { svc } = setup({ [ME]: active, [OTHER_ACCOUNT]: other });
    const common = svc.roomsInCommon(PERSON, '!x', OTHER_ACCOUNT);
    await settle();

    expect(common()?.map((room) => [room.id, room.accountId])).toEqual([
      ['!b', OTHER_ACCOUNT],
    ]);
  });

  it('orders by name, case-insensitively', async () => {
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
    const common = svc.roomsInCommon(PERSON, '!x');
    await settle();

    expect(ids(common())).toEqual(['!a', '!b', '!c']);
  });

  it('caches the signal per user, excluded room and account', () => {
    const { svc } = setup({
      [ME]: fakeClient([]),
      [OTHER_ACCOUNT]: fakeClient([]),
    });

    expect(svc.roomsInCommon(PERSON, '!a')).toBe(
      svc.roomsInCommon(PERSON, '!a'),
    );
    expect(svc.roomsInCommon(PERSON, '!a')).not.toBe(
      svc.roomsInCommon(PERSON, '!a', OTHER_ACCOUNT),
    );
  });

  it('forgets cached views when the signed-in accounts change', () => {
    const { svc, accountIds } = setup({ [ME]: fakeClient([]) });
    const before = svc.roomsInCommon(PERSON, '!a');
    TestBed.tick();

    accountIds.set([ME]);
    TestBed.tick();

    expect(svc.roomsInCommon(PERSON, '!a')).not.toBe(before);
  });

  describe('server mutual rooms (MSC2666)', () => {
    it("uses the server's mutual rooms when advertised", async () => {
      const client = fakeClient(
        [
          // Lazy-loaded rosters: the client does not know the person here.
          fakeRoom({ roomId: '!a', name: 'A' }),
          fakeRoom({ roomId: '!b', name: 'B' }),
          // The client has seen the person leave; local membership wins.
          fakeRoom({ roomId: '!c', name: 'C', members: { [PERSON]: 'leave' } }),
        ],
        {
          features: { [UNSTABLE_FLAG]: true },
          pages: [{ joined: ['!a', '!c'] }],
        },
      );
      const { svc } = setup({ [ME]: client });
      const common = svc.roomsInCommon(PERSON, '!x');
      await settle();

      expect(ids(common())).toEqual(['!a']);
      expect(client.http.authedRequest).toHaveBeenCalledWith(
        'GET',
        UNSTABLE_PATH,
        { user_id: PERSON },
        undefined,
        { prefix: '' },
      );
    });

    it('follows next_batch', async () => {
      const client = fakeClient(
        [
          fakeRoom({ roomId: '!a', name: 'A' }),
          fakeRoom({ roomId: '!b', name: 'B' }),
        ],
        {
          versions: ['v1.19'],
          pages: [{ joined: ['!a'], next_batch: 't1' }, { joined: ['!b'] }],
        },
      );
      const { svc } = setup({ [ME]: client });
      const common = svc.roomsInCommon(PERSON, '!x');
      await settle();

      expect(ids(common())).toEqual(['!a', '!b']);
      expect(client.http.authedRequest.mock.calls).toEqual([
        ['GET', STABLE_PATH, { user_id: PERSON }, undefined, { prefix: '' }],
        [
          'GET',
          STABLE_PATH,
          { user_id: PERSON, from: 't1' },
          undefined,
          { prefix: '' },
        ],
      ]);
    });

    it('falls back to the local list when not advertised', async () => {
      const client = fakeClient([
        fakeRoom({ roomId: '!a', name: 'A' }),
        fakeRoom({ roomId: '!b', name: 'B', members: { [PERSON]: 'join' } }),
      ]);
      const { svc } = setup({ [ME]: client });
      const common = svc.roomsInCommon(PERSON, '!x');
      await settle();

      expect(ids(common())).toEqual(['!b']);
      expect(client.http.authedRequest).not.toHaveBeenCalled();
    });

    it('falls back when the request fails', async () => {
      const client = fakeClient(
        [
          fakeRoom({ roomId: '!a', name: 'A' }),
          fakeRoom({ roomId: '!b', name: 'B', members: { [PERSON]: 'join' } }),
        ],
        { features: { [UNSTABLE_FLAG]: true }, pages: new Error('404') },
      );
      const { svc } = setup({ [ME]: client });
      const common = svc.roomsInCommon(PERSON, '!x');
      await settle();

      expect(ids(common())).toEqual(['!b']);
    });

    it('drops server room ids the client does not have', async () => {
      const client = fakeClient([fakeRoom({ roomId: '!a', name: 'A' })], {
        features: { [UNSTABLE_FLAG]: true },
        pages: [{ joined: ['!a', '!unknown'] }],
      });
      const { svc } = setup({ [ME]: client });
      const common = svc.roomsInCommon(PERSON, '!x');
      await settle();

      expect(ids(common())).toEqual(['!a']);
    });

    it("refetches a second after the person's membership changes", async () => {
      vi.useFakeTimers();
      const client = fakeClient(
        [
          fakeRoom({ roomId: '!a', name: 'A' }),
          fakeRoom({ roomId: '!b', name: 'B' }),
        ],
        {
          features: { [UNSTABLE_FLAG]: true },
          pages: [{ joined: ['!a'] }, { joined: ['!a', '!b'] }],
        },
      );
      const { svc } = setup({ [ME]: client });
      const common = svc.roomsInCommon(PERSON, '!x');
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(common())).toEqual(['!a']);
      TestBed.tick();

      client.emit(RoomStateEvent.Members, {}, {}, { userId: PERSON });
      client.emit(RoomStateEvent.Members, {}, {}, { userId: PERSON });
      await vi.advanceTimersByTimeAsync(999);
      expect(client.http.authedRequest).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(client.http.authedRequest).toHaveBeenCalledTimes(2);
      expect(ids(common())).toEqual(['!a', '!b']);
    });

    it('falls back to the local list when the server does not answer in time', async () => {
      vi.useFakeTimers();
      const client = fakeClient(
        [
          fakeRoom({ roomId: '!a', name: 'A' }),
          fakeRoom({ roomId: '!b', name: 'B', members: { [PERSON]: 'join' } }),
        ],
        { hang: true },
      );
      const { svc } = setup({ [ME]: client });
      const common = svc.roomsInCommon(PERSON, '!x');
      await vi.advanceTimersByTimeAsync(9_999);
      expect(common()).toBeNull();

      await vi.advanceTimersByTimeAsync(1);

      expect(ids(common())).toEqual(['!b']);
    });

    it('an own membership change refetches only views of that account', async () => {
      vi.useFakeTimers();
      const advertised = { features: { [UNSTABLE_FLAG]: true } };
      const mine = fakeClient([], advertised);
      const other = fakeClient([], advertised);
      const { svc } = setup({ [ME]: mine, [OTHER_ACCOUNT]: other });
      svc.roomsInCommon(PERSON, '!x');
      svc.roomsInCommon(PERSON, '!x', OTHER_ACCOUNT);
      await vi.advanceTimersByTimeAsync(0);
      TestBed.tick();
      expect(mine.http.authedRequest).toHaveBeenCalledTimes(1);
      expect(other.http.authedRequest).toHaveBeenCalledTimes(1);

      mine.emit(RoomEvent.MyMembership, {}, 'join');
      await vi.advanceTimersByTimeAsync(1000);

      expect(mine.http.authedRequest).toHaveBeenCalledTimes(2);
      expect(other.http.authedRequest).toHaveBeenCalledTimes(1);
    });

    it('evicts the oldest views beyond the cap', async () => {
      vi.useFakeTimers();
      const client = fakeClient([], { features: { [UNSTABLE_FLAG]: true } });
      const { svc } = setup({ [ME]: client });
      const oldest = svc.roomsInCommon('@u0:hs', '!x');
      for (let i = 1; i <= 20; i++) svc.roomsInCommon(`@u${i}:hs`, '!x');
      await vi.advanceTimersByTimeAsync(0);
      TestBed.tick();
      // Eviction cancelled the oldest view's request before `/versions` answered.
      expect(client.http.authedRequest).toHaveBeenCalledTimes(20);

      client.emit(RoomStateEvent.Members, {}, {}, { userId: '@u0:hs' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(client.http.authedRequest).toHaveBeenCalledTimes(20);
      expect(svc.roomsInCommon('@u0:hs', '!x')).not.toBe(oldest);
    });
  });
});
