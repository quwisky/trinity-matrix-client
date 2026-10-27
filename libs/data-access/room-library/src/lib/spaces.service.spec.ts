import { signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TestBed } from '@angular/core/testing';
import { Subject, finalize, firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SESSION,
  SESSION_ENGINE,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import {
  EngineRequestError,
  type EngineResult,
  engineOk,
} from '@trinity/util/matrix';
import {
  FakeRoomListEngine,
  fakeRoom,
} from '../contract/fake-room-list-engine';
import { ROOM_LIBRARY_GOVERNANCE_POLICY } from './room-library-governance-policy';
import type { HierarchyEntry, RoomInfo } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { SpacesService } from './spaces.service';

function account(accountId: string, generation = 1): SessionAccountStatus {
  return {
    accountId,
    generation,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

function room(roomId: string, name: string, patch: Partial<RoomInfo> = {}) {
  return fakeRoom(roomId, { displayName: name, ...patch });
}

function space(roomId: string, name: string, patch: Partial<RoomInfo> = {}) {
  return room(roomId, name, { isSpace: true, ...patch });
}

/** SpacesService over the fake engine, the real RoomListStore and a fake session for alice. */
function setup(
  rooms: readonly RoomInfo[] = [],
  bobRooms: readonly RoomInfo[] | null = null,
) {
  const fake = new FakeRoomListEngine();
  const alice = fake.alice;
  fake.seed(alice, rooms);
  if (bobRooms) fake.seed(fake.bob, bobRooms);
  const session = signal<SessionSnapshot>({
    ...EMPTY_SESSION,
    activeAccountId: alice,
    accounts: [account(alice), ...(bobRooms ? [account(fake.bob)] : [])],
  });
  const authorize = vi.fn(() => ({ kind: 'allowed' as const }));
  TestBed.configureTestingModule({
    providers: [
      { provide: ROOM_LIST_ENGINE, useValue: fake },
      { provide: SESSION_SNAPSHOT, useValue: session },
      {
        provide: SESSION_ENGINE,
        useFactory: () => ({ session: () => toObservable(session) }),
      },
      { provide: ROOM_LIBRARY_GOVERNANCE_POLICY, useValue: { authorize } },
    ],
  });
  const svc = TestBed.inject(SpacesService);
  /** Links `childId` into `spaceId` as the server would; `via: []` removes it. */
  const link = (
    spaceId: string,
    childId: string,
    {
      order = '',
      via = ['hs.example'],
    }: { order?: string; via?: string[] } = {},
  ): void => {
    fake
      .setSpaceChild(alice, spaceId, childId, { via, suggested: false, order })
      .subscribe();
  };
  return { svc, fake, session, alice, authorize, link };
}

describe('SpacesService', () => {
  it('lists only joined spaces, sorted by name', () => {
    const { svc, alice } = setup([
      space('!b:hs', 'Beta'),
      space('!a:hs', 'Alpha'),
      space('!g:hs', 'Gamma', { membership: 'invite' }),
      room('!r:hs', 'a normal room'),
    ]);

    expect(svc.spaces().map((s) => s.name)).toEqual(['Alpha', 'Beta']);
    expect(svc.spaces()[0]).toMatchObject({
      id: '!a:hs',
      initial: 'A',
      accountId: alice,
    });
  });

  it('resolves child links to joined rooms, ordered by order then name', () => {
    const { svc, link } = setup([
      space('!s:hs', 'Space'),
      room('!a:hs', 'alpha'),
      room('!b:hs', 'bravo'),
      room('!c:hs', 'charlie'),
    ]);
    link('!s:hs', '!c:hs', { order: '30' });
    link('!s:hs', '!a:hs', { order: '10' });
    link('!s:hs', '!b:hs', { order: '20' });

    expect(svc.childRoomIds('!s:hs')).toEqual(['!a:hs', '!b:hs', '!c:hs']);
  });

  it('breaks ties on name when children share an order', () => {
    const { svc, link } = setup([
      space('!s:hs', 'Space'),
      room('!z:hs', 'Zeta'),
      room('!m:hs', 'Mango'),
    ]);
    link('!s:hs', '!z:hs', { order: '10' });
    link('!s:hs', '!m:hs', { order: '10' });

    expect(svc.childRoomIds('!s:hs')).toEqual(['!m:hs', '!z:hs']);
  });

  it('childRoomIds keeps order-then-name and drops links without via', () => {
    // The engine lists links by order then child id; the rail has always broken ties on name.
    const { svc, link } = setup([
      space('!s:hs', 'Space'),
      room('!a:hs', 'Zulu'),
      room('!b:hs', 'Alpha'),
      room('!c:hs', 'Mid'),
      room('!d:hs', 'Bravo'),
    ]);
    link('!s:hs', '!a:hs', { order: '1' });
    link('!s:hs', '!b:hs', { order: '1' });
    link('!s:hs', '!c:hs', { order: '0', via: [] });
    link('!s:hs', '!d:hs');

    expect(svc.childRoomIds('!s:hs')).toEqual(['!b:hs', '!a:hs', '!d:hs']);
  });

  it('drops non-joined children and removed (empty-via) links', () => {
    const { svc, link } = setup([
      space('!s:hs', 'Space'),
      room('!a:hs', 'alpha'),
      room('!b:hs', 'bravo', { membership: 'invite' }),
      room('!x:hs', 'x-removed'),
    ]);
    link('!s:hs', '!a:hs'); // joined → kept
    link('!s:hs', '!b:hs'); // not joined → dropped
    link('!s:hs', '!x:hs', { via: [] }); // removed link → dropped

    expect(svc.childRoomIds('!s:hs')).toEqual(['!a:hs']);
  });

  it('returns no child ids for Home (null) or an unknown space', () => {
    const { svc } = setup([space('!s:hs', 'Space')]);

    expect(svc.childRoomIds(null)).toEqual([]);
    expect(svc.childRoomIds('!nope:hs')).toEqual([]);
  });

  it('finds the spaces that directly contain a room', () => {
    const { svc, link } = setup([
      space('!s1:hs', 'One'),
      space('!s2:hs', 'Two'),
      space('!s3:hs', 'Three'),
      room('!a:hs', 'alpha'),
      room('!b:hs', 'bravo'),
    ]);
    link('!s1:hs', '!a:hs');
    link('!s2:hs', '!a:hs');
    link('!s3:hs', '!b:hs');

    expect(svc.parentSpaceIds('!a:hs')).toEqual(['!s1:hs', '!s2:hs']);
    expect(svc.parentSpaceIds('!b:hs')).toEqual(['!s3:hs']);
  });

  it('reports no parents for a spaceless room or an empty id', () => {
    const { svc } = setup([
      space('!s:hs', 'Space'),
      room('!free:hs', 'Freestanding'),
    ]);

    expect(svc.parentSpaceIds('!free:hs')).toEqual([]);
    expect(svc.parentSpaceIds('')).toEqual([]);
  });

  it('does not treat a grandparent as a parent', () => {
    // MSC3083 membership does not transit the hierarchy: allowing the parent does not admit
    // the grandparent's members, so offering it would promise access it cannot grant.
    const { svc, link } = setup([
      space('!top:hs', 'Top'),
      space('!mid:hs', 'Mid'),
      room('!room:hs', 'Room'),
    ]);
    link('!top:hs', '!mid:hs');
    link('!mid:hs', '!room:hs');

    expect(svc.parentSpaceIds('!room:hs')).toEqual(['!mid:hs']);
  });

  it('drops a parent whose link was removed, unlike m.space.parent', () => {
    // removeRoomFromSpace tombstones the child link (empty via) but deliberately leaves
    // m.space.parent on the room, so reading the room's own state would still name a space
    // that no longer contains it — and grant its members join rights.
    const { svc, link } = setup([
      space('!s:hs', 'Space'),
      room('!a:hs', 'alpha'),
    ]);
    link('!s:hs', '!a:hs', { via: [] });

    expect(svc.parentSpaceIds('!a:hs')).toEqual([]);
  });

  it('refreshes live when a child link arrives', () => {
    const { svc, link } = setup([
      space('!s:hs', 'Space'),
      room('!a:hs', 'alpha'),
      room('!b:hs', 'bravo'),
    ]);
    link('!s:hs', '!a:hs', { order: '10' });
    expect(svc.childRoomIds('!s:hs')).toEqual(['!a:hs']);

    link('!s:hs', '!b:hs', { order: '20' });

    expect(svc.childRoomIds('!s:hs')).toEqual(['!a:hs', '!b:hs']);
  });

  it('keeps the same spaces when an unrelated room changes', async () => {
    const { svc, fake } = setup([
      space('!s:hs', 'Space'),
      room('!r:hs', 'Room'),
    ]);
    const before = svc.spaces();

    await fake.asBob.sendMessage('!r:hs', 'hi');

    expect(svc.spaces().map((s) => s.id)).toEqual(['!s:hs']);
    expect(svc.spaces()).toBe(before);
  });

  it('closes a space link subscription once the space leaves the list', async () => {
    const { svc, fake, alice } = setup([space('!s:hs', 'Space')]);
    const closed = vi.fn();
    const links = fake.spaceChildLinks.bind(fake);
    vi.spyOn(fake, 'spaceChildLinks').mockImplementation((accountId, id) =>
      links(accountId, id).pipe(finalize(closed)),
    );
    expect(svc.spaces().length).toBe(1);

    await firstValueFrom(fake.leave(alice, '!s:hs'));

    expect(svc.spaces()).toEqual([]);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('clears the model when no account is active', () => {
    const { svc, session } = setup([space('!s:hs', 'Space')]);
    expect(svc.spaces().length).toBe(1);

    session.update((s) => ({ ...s, activeAccountId: null }));

    expect(svc.spaces()).toEqual([]);
  });

  it('re-reads space links when the account is signed in again', () => {
    const { svc, fake, session, alice } = setup([space('!s:hs', 'Space')]);
    const links = vi.spyOn(fake, 'spaceChildLinks');
    expect(svc.spaces().length).toBe(1);

    session.update((s) => ({ ...s, accounts: [account(alice, 2)] }));

    expect(svc.spaces().map((s) => s.id)).toEqual(['!s:hs']);
    expect(links).toHaveBeenCalledWith(alice, '!s:hs');
  });

  it('runProjection acknowledges at once and opens nothing of its own', () => {
    const { svc, fake } = setup([space('!s:hs', 'Space')]);
    const links = vi.spyOn(fake, 'spaceChildLinks');
    const seen: unknown[] = [];

    svc.runProjection().subscribe((v) => seen.push(v));
    svc.runProjection().subscribe();

    expect(seen).toEqual([undefined]);
    expect(links).not.toHaveBeenCalled();
  });
});

describe('SpacesService writes', () => {
  it('createSpace creates an m.space room and resolves its id', async () => {
    const { svc, fake, alice } = setup();
    const create = vi.spyOn(fake, 'createRoom');

    const id = await firstValueFrom(
      svc.createSpace(alice, { name: '  My Space  ', topic: '  hi  ' }),
    );

    expect(create).toHaveBeenCalledWith(alice, {
      name: 'My Space', // trimmed
      topic: 'hi', // trimmed
      isPublic: false, // default (invite-only)
      kind: 'space',
      parentSpaceId: null,
    });
    expect(svc.spaces().map((s) => s.id)).toEqual([id]);
  });

  it('createSpace asks for a public space when isPublic', async () => {
    const { svc, fake, alice } = setup();
    const create = vi.spyOn(fake, 'createRoom');

    await firstValueFrom(
      svc.createSpace(alice, { name: 'Open', isPublic: true }),
    );

    expect(create).toHaveBeenCalledWith(
      alice,
      expect.objectContaining({ isPublic: true, topic: null }),
    );
  });

  it('createRoomInSpace creates a room and two-way links it', async () => {
    const { svc, fake, alice, authorize } = setup([space('!s:hs', 'Space')]);
    const create = vi.spyOn(fake, 'createRoom');

    const id = await firstValueFrom(
      svc.createRoomInSpace('!s:hs', { name: 'general' }),
    );

    expect(authorize).toHaveBeenCalledWith(
      { accountId: alice, roomId: '!s:hs' },
      'curate-space',
    );
    // The adapter encrypts a `room` from its first event and links it with our server as via.
    expect(create).toHaveBeenCalledWith(alice, {
      name: 'general',
      topic: null,
      isPublic: false,
      kind: 'room',
      parentSpaceId: '!s:hs',
    });
    expect(fake.spaceParents(id)).toEqual(['!s:hs']);
    expect(svc.childRoomIds('!s:hs')).toEqual([id]);
  });

  it('leaveSpace leaves the space room (children untouched)', async () => {
    const { svc, fake, alice, link } = setup([
      space('!s:hs', 'Space'),
      room('!c:hs', 'child'),
    ]);
    link('!s:hs', '!c:hs');
    const leave = vi.spyOn(fake, 'leave');

    await firstValueFrom(svc.leaveSpace(alice, '!s:hs'));

    expect(leave).toHaveBeenCalledWith(alice, '!s:hs');
    expect(leave).toHaveBeenCalledTimes(1); // only the space, not its children
    expect(svc.spaces()).toEqual([]);
  });

  it('leaveSpace fails closed when the exact Account is unavailable', async () => {
    const { svc, fake } = setup();
    const leave = vi.spyOn(fake, 'leave');

    await expect(
      firstValueFrom(svc.leaveSpace('@gone:hs', '!s:hs')),
    ).rejects.toThrow('Account unavailable.');
    expect(leave).not.toHaveBeenCalled();
  });

  it('marks a space leaving until its leave request settles', async () => {
    const { svc, fake, alice } = setup([space('!s:hs', 'Space')]);
    const reply = new Subject<EngineResult<null>>();
    vi.spyOn(fake, 'leave').mockReturnValue(reply);
    const leaving = svc.leaveSpace(alice, '!s:hs');
    expect(svc.isLeaving(alice, '!s:hs')).toBe(false); // cold

    const done = firstValueFrom(leaving);
    expect(svc.isLeaving(alice, '!s:hs')).toBe(true);
    expect(svc.isLeaving('@other:hs', '!s:hs')).toBe(false);
    expect(svc.isLeaving(alice, '!t:hs')).toBe(false);

    reply.next(engineOk(null));
    reply.complete();
    await done;
    expect(svc.isLeaving(alice, '!s:hs')).toBe(false);
  });

  it('keeps the leaving mark until the last of two overlapping leaves settles', async () => {
    const { svc, fake, alice } = setup([space('!s:hs', 'Space')]);
    const replies: Subject<EngineResult<null>>[] = [];
    vi.spyOn(fake, 'leave').mockImplementation(() => {
      const reply = new Subject<EngineResult<null>>();
      replies.push(reply);
      return reply;
    });
    const settle = (reply: Subject<EngineResult<null>>) => {
      reply.next(engineOk(null));
      reply.complete();
    };

    const first = firstValueFrom(svc.leaveSpace(alice, '!s:hs'));
    const second = firstValueFrom(svc.leaveSpace(alice, '!s:hs'));
    settle(replies[0]);
    await first;
    expect(svc.isLeaving(alice, '!s:hs')).toBe(true);

    settle(replies[1]);
    await second;
    expect(svc.isLeaving(alice, '!s:hs')).toBe(false);
  });

  it('clears the leaving mark when the leave fails', async () => {
    const { svc, fake, alice } = setup([space('!s:hs', 'Space')]);
    fake.failNext('request-failed');

    await expect(
      firstValueFrom(svc.leaveSpace(alice, '!s:hs')),
    ).rejects.toBeInstanceOf(EngineRequestError);
    expect(svc.isLeaving(alice, '!s:hs')).toBe(false);
  });

  it('joinRoom routes through the via servers when provided', async () => {
    const { svc, fake, alice } = setup();
    const join = vi
      .spyOn(fake, 'join')
      .mockReturnValue(of(engineOk({ roomId: '!c:hs' })));

    await firstValueFrom(
      svc.joinRoom(alice, '!c:hs', ['a.example', 'b.example']),
    );

    expect(join).toHaveBeenCalledWith(alice, '!c:hs', [
      'a.example',
      'b.example',
    ]);
  });

  it('joinRoom passes no via servers when there are none', async () => {
    const { svc, fake, alice } = setup();
    const join = vi
      .spyOn(fake, 'join')
      .mockReturnValue(of(engineOk({ roomId: '!c:hs' })));

    await firstValueFrom(svc.joinRoom(alice, '!c:hs'));
    await firstValueFrom(svc.joinRoom(alice, '!c:hs', []));

    expect(join).toHaveBeenNthCalledWith(1, alice, '!c:hs', []);
    expect(join).toHaveBeenNthCalledWith(2, alice, '!c:hs', []);
  });

  it('removeRoomFromSpace removes the m.space.child link for the child', async () => {
    const { svc, fake, alice, link } = setup([
      space('!s:hs', 'Space'),
      room('!c:hs', 'child'),
    ]);
    link('!s:hs', '!c:hs');
    const write = vi.spyOn(fake, 'setSpaceChild');

    await firstValueFrom(svc.removeRoomFromSpace('!s:hs', '!c:hs'));

    expect(write).toHaveBeenCalledWith(alice, '!s:hs', '!c:hs', null);
    expect(svc.childRoomIds('!s:hs')).toEqual([]);
  });
});

// Space hierarchy: openSpace fetches a space's *full* child set (joined + not)
// via spaceHierarchy and projects each child to a view model.
interface HierarchyChild {
  childId: string;
  order?: string;
  suggested?: boolean;
  via?: string[];
}

function entry(
  roomId: string,
  patch: Partial<HierarchyEntry> & { children?: HierarchyChild[] } = {},
): HierarchyEntry {
  const { children = [], ...rest } = patch;
  return {
    roomId,
    name: null,
    canonicalAlias: null,
    topic: null,
    avatarMxc: null,
    joinedMemberCount: 0,
    joinRule: null,
    isSpace: false,
    childrenState: children.map((c) => ({
      childId: c.childId,
      via: c.via ?? ['hs.example'],
      suggested: c.suggested ?? false,
      order: c.order ?? '',
    })),
    ...rest,
  };
}

/** Alice holds `!s:hs` (unless `holdsSpace` is false); `spaceHierarchy` answers `entries`. */
function setupHierarchy(opts: {
  entries?: HierarchyEntry[];
  joined?: string[];
  /** Joined ids that are themselves spaces — a child of a space may be either. */
  joinedSpaces?: string[];
  holdsSpace?: boolean;
  bobRooms?: RoomInfo[];
}) {
  const rows = [
    ...(opts.holdsSpace === false ? [] : [space('!s:hs', 'Space')]),
    ...(opts.joined ?? []).map((id) => room(id, id)),
    ...(opts.joinedSpaces ?? []).map((id) => space(id, id)),
  ];
  const context = setup(rows, opts.bobRooms ?? null);
  const hierarchy = vi
    .spyOn(context.fake, 'spaceHierarchy')
    .mockReturnValue(of(engineOk(opts.entries ?? [])));
  /** Lists `id` as joined for alice, as `/sync` would. */
  const join = (id: string, options: { readonly space?: boolean } = {}) => {
    rows.push(options.space ? space(id, id) : room(id, id));
    context.fake.seed(context.alice, [...rows]);
  };
  return { ...context, hierarchy, join };
}

describe('SpacesService hierarchy', () => {
  it('projects the full child set, excludes the root, orders by order then name', () => {
    const { svc, hierarchy, alice } = setupHierarchy({
      entries: [
        entry('!s:hs', {
          name: 'Space',
          isSpace: true,
          children: [
            { childId: '!b:hs', order: '20' },
            { childId: '!a:hs', order: '10', suggested: true },
            { childId: '!sub:hs', order: '10' }, // ties with !a on order → name breaks
          ],
        }),
        entry('!a:hs', {
          name: 'alpha',
          topic: 'first',
          joinedMemberCount: 5,
          joinRule: 'public',
          avatarMxc: 'mxc://hs/a',
        }),
        entry('!b:hs', { name: 'bravo', joinedMemberCount: 2 }),
        entry('!sub:hs', { name: 'Sub', isSpace: true }),
      ],
      joined: ['!a:hs'],
    });

    const command = svc.openSpace('!s:hs');
    expect(hierarchy).not.toHaveBeenCalled();

    void command.subscribe();

    expect(hierarchy).toHaveBeenCalledWith(alice, '!s:hs', { maxPages: 5 });
    const children = svc.openSpaceChildren();
    // Root excluded; ordered by order ('10' < '20') then name ('Sub' > 'alpha').
    expect(children.map((c) => c.roomId)).toEqual([
      '!a:hs',
      '!sub:hs',
      '!b:hs',
    ]);
    expect(children[0]).toMatchObject({
      accountId: alice,
      roomId: '!a:hs',
      name: 'alpha',
      initial: 'A',
      topic: 'first',
      avatarMxc: 'mxc://hs/a',
      memberCount: 5,
      joinRule: 'public',
      suggested: true,
      isSpace: false,
      via: ['hs.example'],
      joined: true, // we are joined to !a
    });
    expect(children[1]).toMatchObject({ roomId: '!sub:hs', isSpace: true });
    expect(children[2]).not.toHaveProperty('topic');
  });

  it('falls back to the alias, then the id, for an unnamed child', () => {
    const { svc } = setupHierarchy({
      entries: [
        entry('!s:hs', {
          isSpace: true,
          children: [
            { childId: '!a:hs', order: '1' },
            { childId: '!b:hs', order: '2' },
          ],
        }),
        entry('!a:hs', { canonicalAlias: '#alias:hs' }),
        entry('!b:hs'),
      ],
    });

    void svc.openSpace('!s:hs').subscribe();

    expect(svc.openSpaceChildren().map((c) => [c.name, c.joinRule])).toEqual([
      ['#alias:hs', ''],
      ['!b:hs', ''],
    ]);
  });

  it('orders children by code point, not by locale collation', () => {
    // MSC1772 mandates Unicode code point order, where 'B' (66) precedes 'a' (97);
    // `localeCompare` case-folds and puts 'a' first, arranging the Organise dialog
    // differently from every other client. Names run the other way so only the order
    // field can produce this result.
    const { svc } = setupHierarchy({
      entries: [
        entry('!s:hs', {
          name: 'Space',
          isSpace: true,
          children: [
            { childId: '!upper:hs', order: 'B' },
            { childId: '!lower:hs', order: 'a' },
          ],
        }),
        entry('!upper:hs', { name: 'zulu' }),
        entry('!lower:hs', { name: 'alpha' }),
      ],
    });

    void svc.openSpace('!s:hs').subscribe();

    expect(svc.openSpaceChildren().map((c) => c.roomId)).toEqual([
      '!upper:hs',
      '!lower:hs',
    ]);
  });

  it('sorts a child with no order key after the children that have one', () => {
    // The spec sorts children with a valid order ahead of those without, but
    // `''.localeCompare('z')` is -1, which floats the unordered child to the top.
    const { svc } = setupHierarchy({
      entries: [
        entry('!s:hs', {
          name: 'Space',
          isSpace: true,
          children: [
            { childId: '!unordered:hs' },
            { childId: '!ordered:hs', order: 'z' },
          ],
        }),
        entry('!unordered:hs', { name: 'alpha' }),
        entry('!ordered:hs', { name: 'zulu' }),
      ],
    });

    void svc.openSpace('!s:hs').subscribe();

    expect(svc.openSpaceChildren().map((c) => c.roomId)).toEqual([
      '!ordered:hs',
      '!unordered:hs',
    ]);
  });

  it('splits not-joined rooms from child spaces', () => {
    const { svc } = setupHierarchy({
      entries: [
        entry('!s:hs', {
          name: 'Space',
          isSpace: true,
          children: [
            { childId: '!joined:hs', order: '10' },
            { childId: '!room:hs', order: '20' },
            { childId: '!sub:hs', order: '30' },
          ],
        }),
        entry('!joined:hs', { name: 'joined-room' }),
        entry('!room:hs', { name: 'open-room' }),
        entry('!sub:hs', { name: 'Sub Space', isSpace: true }),
      ],
      joined: ['!joined:hs'],
    });

    void svc.openSpace('!s:hs').subscribe();

    // notJoinedRooms: not joined AND not a space → only the open room.
    expect(svc.notJoinedRooms().map((c) => c.roomId)).toEqual(['!room:hs']);
    // childSpaces: every sub-space, regardless of membership.
    expect(svc.childSpaces().map((c) => c.roomId)).toEqual(['!sub:hs']);
  });

  it('flips a child to joined when its membership syncs, without re-fetching', () => {
    // The hierarchy fetch says who the children are, the room list says which of them you
    // are in, and the second must reach the screen on its own. The hierarchy is asserted
    // untouched because re-fetching would be a different (and much more expensive) way to
    // be right.
    const { svc, hierarchy, join } = setupHierarchy({
      entries: [
        entry('!s:hs', {
          name: 'Space',
          isSpace: true,
          children: [{ childId: '!room:hs', order: '10' }],
        }),
        entry('!room:hs', { name: 'open-room' }),
      ],
    });

    void svc.openSpace('!s:hs').subscribe();
    expect(svc.notJoinedRooms().map((c) => c.roomId)).toEqual(['!room:hs']);
    const fetches = hierarchy.mock.calls.length;

    join('!room:hs');

    expect(svc.notJoinedRooms()).toEqual([]);
    expect(svc.openSpaceChildren()[0].joined).toBe(true);
    expect(hierarchy.mock.calls.length).toBe(fetches);
  });

  it('holds the same children when a room list change alters no membership', async () => {
    // Without the joined-set's structural equality every room list change re-derives
    // openSpaceChildren and, through it, notJoinedRooms, childSpaces, the channel sidebar
    // and the organise dialog — for no change at all.
    const { svc, fake } = setupHierarchy({
      entries: [
        entry('!s:hs', {
          name: 'Space',
          isSpace: true,
          children: [{ childId: '!room:hs', order: '10' }],
        }),
        entry('!room:hs', { name: 'open-room' }),
      ],
      joined: ['!room:hs'],
    });
    void svc.openSpace('!s:hs').subscribe();
    const before = svc.openSpaceChildren();

    await fake.asBob.sendMessage('!room:hs', 'hi');

    expect(svc.openSpaceChildren()).toBe(before);
  });

  it('counts a joined SUB-SPACE as joined, not just a room', () => {
    // A child of a space may be either, and the joined set is built on membership alone —
    // nothing there excludes spaces. Every other fixture here is a plain room, so this is
    // the only case that would notice an `isSpace` filter creeping into that pass.
    const { svc } = setupHierarchy({
      entries: [
        entry('!s:hs', {
          name: 'Space',
          isSpace: true,
          children: [{ childId: '!sub:hs', order: '10' }],
        }),
        entry('!sub:hs', { name: 'Sub Space', isSpace: true }),
      ],
      joinedSpaces: ['!sub:hs'],
    });

    void svc.openSpace('!s:hs').subscribe();

    expect(svc.childSpaces().map((c) => c.roomId)).toEqual(['!sub:hs']);
    expect(svc.childSpaces()[0].joined).toBe(true);
  });

  it('reports joined children without a projection lifetime', () => {
    // The joined flag comes from the room list store, which keeps every live account's
    // list itself, so nothing has to run before a space is opened.
    const { svc } = setupHierarchy({
      entries: [
        entry('!s:hs', {
          name: 'Space',
          isSpace: true,
          children: [{ childId: '!room:hs', order: '10' }],
        }),
        entry('!room:hs', { name: 'open-room' }),
      ],
      joined: ['!room:hs'],
    });

    void svc.openSpace('!s:hs').subscribe();

    expect(svc.openSpaceChildren()[0].joined).toBe(true);
  });

  it('clears the open-space children for Home (null) without fetching', () => {
    const { svc, hierarchy } = setupHierarchy({});

    void svc.openSpace(null).subscribe();

    expect(hierarchy).not.toHaveBeenCalled();
    expect(svc.openSpaceChildren()).toEqual([]);
    expect(svc.childrenLoading()).toBe(false);
  });

  it('shows loading while the hierarchy request is in flight', () => {
    const { svc, hierarchy } = setupHierarchy({});
    const reply = new Subject<EngineResult<readonly HierarchyEntry[]>>();
    hierarchy.mockReturnValue(reply);

    void svc.openSpace('!s:hs').subscribe();
    expect(svc.childrenLoading()).toBe(true);

    reply.next(engineOk([entry('!s:hs', { isSpace: true })]));
    reply.complete();
    expect(svc.childrenLoading()).toBe(false);
  });

  it('skips the hierarchy of a space the active account does not hold', () => {
    // Mixed view: the active account can be showing a space only another account holds.
    // Its own /hierarchy read would fail for a private space, so there is nothing to fetch.
    const { svc, hierarchy, fake } = setupHierarchy({
      holdsSpace: false,
      bobRooms: [space('!s:hs', 'Space')],
    });
    fake.failNext('request-failed');

    void svc.openSpace('!s:hs').subscribe();

    expect(hierarchy).not.toHaveBeenCalled();
    expect(svc.childrenError()).toBeNull();
    expect(svc.childrenLoading()).toBe(false);
    expect(svc.openSpaceChildren()).toEqual([]);
  });

  it('skips the hierarchy of a space the active account has left', () => {
    // A left space is not in the room list at all.
    const { svc, hierarchy } = setupHierarchy({ holdsSpace: false });

    void svc.openSpace('!s:hs').subscribe();

    expect(hierarchy).not.toHaveBeenCalled();
    expect(svc.childrenError()).toBeNull();
  });

  it('skips the hierarchy of a space the active account is only invited to', () => {
    // Held means joined: a space opens once the join has synced (RoomReadinessService).
    const { svc, hierarchy, fake, alice } = setupHierarchy({
      holdsSpace: false,
    });
    fake.seed(alice, [space('!s:hs', 'Space', { membership: 'invite' })]);

    void svc.openSpace('!s:hs').subscribe();
    TestBed.tick();

    expect(hierarchy).not.toHaveBeenCalled();
  });

  // A restored space can be named before the account's first sync brings it.
  it('waits for the active account to join a space before fetching its hierarchy', () => {
    const { svc, hierarchy, join, alice } = setupHierarchy({
      entries: [entry('!s:hs', { name: 'Space', isSpace: true })],
      holdsSpace: false,
    });

    void svc.openSpace('!s:hs').subscribe();
    TestBed.tick();
    expect(hierarchy).not.toHaveBeenCalled();
    expect(svc.childrenLoading()).toBe(false);

    join('!s:hs', { space: true });
    TestBed.tick();

    expect(hierarchy).toHaveBeenCalledOnce();
    expect(hierarchy).toHaveBeenCalledWith(alice, '!s:hs', { maxPages: 5 });
  });

  it('stops waiting for a space once another one is opened', () => {
    const { svc, hierarchy, join } = setupHierarchy({ holdsSpace: false });

    void svc.openSpace('!s:hs').subscribe();
    void svc.openSpace(null).subscribe();
    join('!s:hs', { space: true });
    TestBed.tick();

    expect(hierarchy).not.toHaveBeenCalled();
  });

  it('never fetches a space the active account has left, even after a room list change', () => {
    const { svc, hierarchy, join } = setupHierarchy({ holdsSpace: false });

    void svc.openSpace('!s:hs').subscribe();
    join('!other:hs');
    TestBed.tick();

    expect(hierarchy).not.toHaveBeenCalled();
  });

  // The wait is a lifetime: the next openSpace call ends it (above), and so does a switch of
  // the active Account.
  it('ends the wait for a space to be joined when the active account switches', () => {
    const { svc, session, fake } = setupHierarchy({
      holdsSpace: false,
      bobRooms: [],
    });
    let ended = false;
    svc.openSpace('!s:hs').subscribe({ complete: () => (ended = true) });
    TestBed.tick();
    expect(ended).toBe(false);

    session.update((s) => ({ ...s, activeAccountId: fake.bob }));
    TestBed.tick();

    expect(ended).toBe(true);
    expect(svc.childrenLoading()).toBe(false);
  });

  it('surfaces a hierarchy fetch failure in childrenError', () => {
    const { svc, hierarchy, fake } = setupHierarchy({});
    hierarchy.mockRestore();
    fake.failNext('request-failed');

    void svc.openSpace('!s:hs').subscribe({ error: () => undefined });

    expect(svc.childrenError()).toBe('Something went wrong. Try again.');
    expect(svc.childrenLoading()).toBe(false);
    expect(svc.openSpaceChildren()).toEqual([]);

    fake.failNext('account-not-live');
    void svc.openSpace('!s:hs').subscribe({ error: () => undefined });
    expect(svc.childrenError()).toBe('Account unavailable.');
  });

  it('re-projects onto the newly-active account when the active account switches', () => {
    const { svc, session, fake } = setupHierarchy({
      entries: [
        entry('!s:hs', {
          name: 'Space',
          isSpace: true,
          children: [{ childId: '!room:hs' }],
        }),
        entry('!room:hs', { name: 'open-room' }),
      ],
      bobRooms: [space('!b:hs', 'B space')],
    });
    void svc.openSpace('!s:hs').subscribe();
    expect(svc.spaces().map((s) => s.id)).toEqual(['!s:hs']);
    expect(svc.openSpaceChildren().length).toBe(1);

    session.update((s) => ({ ...s, activeAccountId: fake.bob }));
    TestBed.tick();

    expect(svc.spaces().map((s) => s.id)).toEqual(['!b:hs']);
    expect(svc.openSpaceChildren()).toEqual([]);
  });
});
