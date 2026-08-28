import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type MatrixClient } from 'matrix-js-sdk';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { SpacesService } from './spaces.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomActionPermissionsService } from './room-action-permissions.service';

/**
 * Wire a fake matrix-js-sdk client into a mocked {@link MatrixClientService}.
 *
 * `activeUserId` is writable so a test can drive an account switch — the projection
 * re-wires off it, and a read-only signal here would make that untestable.
 */
const activeUserId = signal<string | null>(null);

function provideMatrix(client: unknown): MatrixClientService {
  activeUserId.set(null);
  TestBed.configureTestingModule({
    providers: [
      SpacesService,
      MockProvider(RoomActionPermissionsService, {
        room: () => ({
          invite: { available: true, reason: null },
          curateSpace: { available: true, reason: null },
        }),
        assert: vi.fn(),
      }),
      MockProvider(MatrixClientService, {
        activeUserId: activeUserId.asReadonly(),
      }),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  ngMocks.stubMember(matrix, 'isInitialized', true);
  ngMocks.stubMember(matrix, 'instance', client as MatrixClient);
  return matrix;
}

// A single `m.space.child` link. `via` defaults to a non-empty array (a valid
// link); pass `via: []` to model a removed/tombstoned child.
interface ChildLink {
  childId: string;
  order?: string;
  via?: string[];
}

interface RoomOpts {
  roomId: string;
  name: string;
  space?: boolean;
  membership?: string;
  children?: ChildLink[];
}

// Minimal fakes shaped like the bits of matrix-js-sdk that SpacesService reads.
function fakeRoom(opts: RoomOpts) {
  // `children` is read live (a captured array ref) so a test can push a link and
  // then fire a state-event to assert the live refresh.
  const children = opts.children ?? [];
  return {
    roomId: opts.roomId,
    name: opts.name,
    isSpaceRoom: () => opts.space ?? false,
    getMyMembership: () => opts.membership ?? 'join',
    getMxcAvatarUrl: () => null,
    // The service reads room state via the live timeline (liveRoomState()),
    // which is what the SDK's deprecated `currentState` aliased.
    getLiveTimeline: () => ({
      getState: () => ({
        getStateEvents: (type: string) =>
          type === 'm.space.child'
            ? children.map((c) => ({
                getStateKey: () => c.childId,
                getContent: () => ({
                  via: c.via ?? ['hs.example'],
                  ...(c.order !== undefined ? { order: c.order } : {}),
                }),
              }))
            : [],
      }),
    }),
    _children: children, // test-only handle for mutation
  };
}

function setup(rooms: ReturnType<typeof fakeRoom>[]) {
  const byId = new Map(rooms.map((r) => [r.roomId, r]));
  const client = {
    getRooms: () => rooms,
    getRoom: (id: string) => byId.get(id) ?? null,
    on: vi.fn(),
    off: vi.fn(),
  };
  const matrix = provideMatrix(client);
  const svc = TestBed.inject(SpacesService);
  svc.connect();
  return { svc, client, matrix };
}

/** Pull a captured client listener by event name (for simulating live updates). */
function handlerFor(client: { on: Mock }, event: string) {
  const call = client.on.mock.calls.find(([e]) => e === event);
  return call?.[1] as ((...args: unknown[]) => void) | undefined;
}

describe('SpacesService', () => {
  it('lists only joined spaces, sorted by name', () => {
    const { svc } = setup([
      fakeRoom({ roomId: '!b:hs', name: 'Beta', space: true }),
      fakeRoom({ roomId: '!a:hs', name: 'Alpha', space: true }),
      fakeRoom({
        roomId: '!g:hs',
        name: 'Gamma',
        space: true,
        membership: 'leave',
      }),
      fakeRoom({ roomId: '!r:hs', name: 'a normal room' }),
    ]);

    expect(svc.spaces().map((s) => s.name)).toEqual(['Alpha', 'Beta']);
    expect(svc.spaces()[0]).toMatchObject({ id: '!a:hs', initial: 'A' });
  });

  it('resolves child links to joined rooms, ordered by order then name', () => {
    const { svc } = setup([
      fakeRoom({
        roomId: '!s:hs',
        name: 'Space',
        space: true,
        children: [
          { childId: '!c:hs', order: '30' },
          { childId: '!a:hs', order: '10' },
          { childId: '!b:hs', order: '20' },
        ],
      }),
      fakeRoom({ roomId: '!a:hs', name: 'alpha' }),
      fakeRoom({ roomId: '!b:hs', name: 'bravo' }),
      fakeRoom({ roomId: '!c:hs', name: 'charlie' }),
    ]);

    expect(svc.childRoomIds('!s:hs')).toEqual(['!a:hs', '!b:hs', '!c:hs']);
  });

  it('breaks ties on name when children share an order', () => {
    const { svc } = setup([
      fakeRoom({
        roomId: '!s:hs',
        name: 'Space',
        space: true,
        children: [
          { childId: '!z:hs', order: '10' },
          { childId: '!m:hs', order: '10' },
        ],
      }),
      fakeRoom({ roomId: '!z:hs', name: 'Zeta' }),
      fakeRoom({ roomId: '!m:hs', name: 'Mango' }),
    ]);

    expect(svc.childRoomIds('!s:hs')).toEqual(['!m:hs', '!z:hs']);
  });

  it('drops non-joined children and removed (empty-via) links', () => {
    const { svc } = setup([
      fakeRoom({
        roomId: '!s:hs',
        name: 'Space',
        space: true,
        children: [
          { childId: '!a:hs' }, // joined → kept
          { childId: '!b:hs' }, // not joined → dropped
          { childId: '!x:hs', via: [] }, // removed link → dropped
        ],
      }),
      fakeRoom({ roomId: '!a:hs', name: 'alpha' }),
      fakeRoom({ roomId: '!b:hs', name: 'bravo', membership: 'leave' }),
      fakeRoom({ roomId: '!x:hs', name: 'x-removed' }),
    ]);

    expect(svc.childRoomIds('!s:hs')).toEqual(['!a:hs']);
  });

  it('returns no child ids for Home (null) or an unknown space', () => {
    const { svc } = setup([
      fakeRoom({ roomId: '!s:hs', name: 'Space', space: true }),
    ]);

    expect(svc.childRoomIds(null)).toEqual([]);
    expect(svc.childRoomIds('!nope:hs')).toEqual([]);
  });

  it('finds the spaces that directly contain a room', () => {
    const { svc } = setup([
      fakeRoom({
        roomId: '!s1:hs',
        name: 'One',
        space: true,
        children: [{ childId: '!a:hs' }],
      }),
      fakeRoom({
        roomId: '!s2:hs',
        name: 'Two',
        space: true,
        children: [{ childId: '!a:hs' }],
      }),
      fakeRoom({
        roomId: '!s3:hs',
        name: 'Three',
        space: true,
        children: [{ childId: '!b:hs' }],
      }),
      fakeRoom({ roomId: '!a:hs', name: 'alpha' }),
      fakeRoom({ roomId: '!b:hs', name: 'bravo' }),
    ]);

    expect(svc.parentSpaceIds('!a:hs')).toEqual(['!s1:hs', '!s2:hs']);
    expect(svc.parentSpaceIds('!b:hs')).toEqual(['!s3:hs']);
  });

  it('reports no parents for a spaceless room or an empty id', () => {
    const { svc } = setup([
      fakeRoom({ roomId: '!s:hs', name: 'Space', space: true }),
      fakeRoom({ roomId: '!free:hs', name: 'Freestanding' }),
    ]);

    expect(svc.parentSpaceIds('!free:hs')).toEqual([]);
    expect(svc.parentSpaceIds('')).toEqual([]);
  });

  it('does not treat a grandparent as a parent', () => {
    // MSC3083 membership does not transit the hierarchy: allowing the parent does not admit
    // the grandparent's members, so offering it would promise access it cannot grant.
    const { svc } = setup([
      fakeRoom({
        roomId: '!top:hs',
        name: 'Top',
        space: true,
        children: [{ childId: '!mid:hs' }],
      }),
      fakeRoom({
        roomId: '!mid:hs',
        name: 'Mid',
        space: true,
        children: [{ childId: '!room:hs' }],
      }),
      fakeRoom({ roomId: '!room:hs', name: 'Room' }),
    ]);

    expect(svc.parentSpaceIds('!room:hs')).toEqual(['!mid:hs']);
  });

  it('drops a parent whose link was removed, unlike m.space.parent', () => {
    // removeRoomFromSpace tombstones the child link (empty via) but deliberately leaves
    // m.space.parent on the room, so reading the room's own state would still name a space
    // that no longer contains it — and grant its members join rights.
    const { svc } = setup([
      fakeRoom({
        roomId: '!s:hs',
        name: 'Space',
        space: true,
        children: [{ childId: '!a:hs', via: [] }],
      }),
      fakeRoom({ roomId: '!a:hs', name: 'alpha' }),
    ]);

    expect(svc.parentSpaceIds('!a:hs')).toEqual([]);
  });

  it('refreshes live when a child link arrives (RoomState.events)', async () => {
    const space = fakeRoom({
      roomId: '!s:hs',
      name: 'Space',
      space: true,
      children: [{ childId: '!a:hs', order: '10' }],
    });
    const { svc, client } = setup([
      space,
      fakeRoom({ roomId: '!a:hs', name: 'alpha' }),
      fakeRoom({ roomId: '!b:hs', name: 'bravo' }),
    ]);

    expect(svc.childRoomIds('!s:hs')).toEqual(['!a:hs']);

    // A new child is linked, then the homeserver delivers the state event.
    space._children.push({ childId: '!b:hs', order: '20' });
    const onState = handlerFor(client, 'RoomState.events');
    onState?.({ getType: () => 'm.space.child' });
    await Promise.resolve(); // the refresh is coalesced into a microtask

    expect(svc.childRoomIds('!s:hs')).toEqual(['!a:hs', '!b:hs']);
  });

  it('ignores unrelated state events', async () => {
    const { svc, client } = setup([
      fakeRoom({ roomId: '!s:hs', name: 'Space', space: true }),
    ]);
    const onState = handlerFor(client, 'RoomState.events');

    onState?.({ getType: () => 'm.room.topic' });
    // Flush first: refreshes are coalesced, so asserting synchronously would pass even
    // if this unrelated event HAD wrongly scheduled one.
    await Promise.resolve();

    // Still the single space, no churn from an unrelated state change.
    expect(svc.spaces().map((s) => s.id)).toEqual(['!s:hs']);
  });

  it('detaches listeners and clears the model on disconnect (teardown)', () => {
    const { svc, client } = setup([
      fakeRoom({ roomId: '!s:hs', name: 'Space', space: true }),
    ]);
    expect(svc.spaces().length).toBe(1);

    svc.disconnect();

    expect(client.off).toHaveBeenCalled();
    expect(svc.spaces()).toEqual([]);
  });

  it('rewires onto a new client after re-login instead of freezing', () => {
    const {
      svc,
      client: clientA,
      matrix,
    } = setup([fakeRoom({ roomId: '!a:hs', name: 'A-space', space: true })]);
    expect(svc.spaces().map((s) => s.id)).toEqual(['!a:hs']);

    const roomsB = [
      fakeRoom({ roomId: '!b:hs', name: 'B-space', space: true }),
    ];
    const byIdB = new Map(roomsB.map((r) => [r.roomId, r]));
    const clientB = {
      getRooms: () => roomsB,
      getRoom: (id: string) => byIdB.get(id) ?? null,
      on: vi.fn(),
      off: vi.fn(),
    };
    ngMocks.stubMember(matrix, 'instance', clientB as unknown as MatrixClient);
    svc.connect();

    expect(svc.spaces().map((s) => s.id)).toEqual(['!b:hs']); // not frozen on A
    expect(clientA.off).toHaveBeenCalled(); // old listeners detached
    expect(clientB.on).toHaveBeenCalled(); // new client wired
  });

  it('ignores a repeat connect() for the same client', () => {
    const { svc, client } = setup([]);
    const wired = client.on.mock.calls.length;

    svc.connect();

    expect(client.on.mock.calls.length).toBe(wired); // no double-wiring
  });
});

// Write paths: createSpace / createRoomInSpace / leaveSpace. The read model is
// driven by sync listeners (covered above), so these assert the SDK calls only.
function setupWrites() {
  const createRoom = vi.fn().mockResolvedValue({ room_id: '!new:hs' });
  const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$e' });
  const leave = vi.fn().mockResolvedValue({});
  const joinRoom = vi.fn().mockResolvedValue({ roomId: '!c:hs' });
  const client = {
    getRooms: () => [],
    getRoom: () => null,
    // `@me:hs.example` → the `via` homeserver is `hs.example`.
    getUserId: () => '@me:hs.example',
    createRoom,
    sendStateEvent,
    leave,
    joinRoom,
    on: vi.fn(),
    off: vi.fn(),
  };
  provideMatrix(client);
  const svc = TestBed.inject(SpacesService);
  return { svc, createRoom, sendStateEvent, leave, joinRoom };
}

describe('SpacesService writes', () => {
  it('createSpace creates an m.space room and resolves its id', async () => {
    const { svc, createRoom } = setupWrites();

    const id = await firstValueFrom(
      svc.createSpace({ name: '  My Space  ', topic: '  hi  ' }),
    );

    expect(id).toBe('!new:hs');
    expect(createRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        creation_content: { type: 'm.space' },
        name: 'My Space', // trimmed
        topic: 'hi', // trimmed
        visibility: 'private', // default (invite-only)
        preset: 'private_chat',
      }),
    );
  });

  it('createSpace uses public visibility/preset when isPublic', async () => {
    const { svc, createRoom } = setupWrites();

    await firstValueFrom(svc.createSpace({ name: 'Open', isPublic: true }));

    expect(createRoom).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'public', preset: 'public_chat' }),
    );
    // No topic provided → the field is omitted entirely.
    expect(createRoom.mock.calls[0][0]).not.toHaveProperty('topic');
  });

  it('createRoomInSpace creates an encrypted room and two-way links it', async () => {
    const { svc, createRoom, sendStateEvent } = setupWrites();

    const id = await firstValueFrom(
      svc.createRoomInSpace('!s:hs', { name: 'general' }),
    );

    expect(id).toBe('!new:hs');
    // Encrypted from the first event via initial_state.
    expect(createRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'general',
        initial_state: [
          {
            type: 'm.room.encryption',
            state_key: '',
            content: { algorithm: 'm.megolm.v1.aes-sha2' },
          },
        ],
      }),
    );
    // Child link on the space, parent link back on the child — both carry `via`.
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!s:hs',
      'm.space.child',
      { via: ['hs.example'], suggested: true },
      '!new:hs',
    );
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!new:hs',
      'm.space.parent',
      { via: ['hs.example'], canonical: true },
      '!s:hs',
    );
  });

  it('leaveSpace leaves the space room (children untouched)', async () => {
    const { svc, leave } = setupWrites();

    await firstValueFrom(svc.leaveSpace('!s:hs'));

    expect(leave).toHaveBeenCalledWith('!s:hs');
    expect(leave).toHaveBeenCalledTimes(1); // only the space, not its children
  });

  it('joinRoom routes through the via servers when provided', async () => {
    const { svc, joinRoom } = setupWrites();

    await firstValueFrom(svc.joinRoom('!c:hs', ['a.example', 'b.example']));

    expect(joinRoom).toHaveBeenCalledWith('!c:hs', {
      viaServers: ['a.example', 'b.example'],
    });
  });

  it('joinRoom passes no opts when there are no via servers', async () => {
    const { svc, joinRoom } = setupWrites();

    await firstValueFrom(svc.joinRoom('!c:hs'));
    await firstValueFrom(svc.joinRoom('!c:hs', []));

    expect(joinRoom).toHaveBeenNthCalledWith(1, '!c:hs', undefined);
    expect(joinRoom).toHaveBeenNthCalledWith(2, '!c:hs', undefined);
  });

  it('removeRoomFromSpace sends an empty m.space.child (tombstone) for the child', async () => {
    const { svc, sendStateEvent } = setupWrites();

    await firstValueFrom(svc.removeRoomFromSpace('!s:hs', '!c:hs'));

    expect(sendStateEvent).toHaveBeenCalledWith(
      '!s:hs',
      'm.space.child',
      {}, // empty content / no via = the child link is removed
      '!c:hs',
    );
  });
});

// Space hierarchy: openSpace fetches a space's *full* child set (joined + not)
// via getRoomHierarchy and projects each child to a view model.
interface HierarchyChild {
  childId: string;
  order?: string;
  suggested?: boolean;
  via?: string[];
}
interface HierarchyRoomOpts {
  roomId: string;
  name?: string;
  topic?: string;
  avatarUrl?: string;
  members?: number;
  joinRule?: string;
  isSpace?: boolean;
  children?: HierarchyChild[];
}

function hroom(opts: HierarchyRoomOpts) {
  return {
    room_id: opts.roomId,
    name: opts.name,
    topic: opts.topic,
    avatar_url: opts.avatarUrl,
    num_joined_members: opts.members ?? 0,
    world_readable: false,
    guest_can_join: false,
    join_rule: opts.joinRule,
    room_type: opts.isSpace ? 'm.space' : undefined,
    children_state: (opts.children ?? []).map((c) => ({
      type: 'm.space.child',
      state_key: c.childId,
      sender: '@x:hs',
      origin_server_ts: 0,
      content: {
        ...(c.order !== undefined ? { order: c.order } : {}),
        ...(c.suggested !== undefined ? { suggested: c.suggested } : {}),
        via: c.via ?? ['hs.example'],
      },
    })),
  };
}

function setupHierarchy(opts: {
  rooms: ReturnType<typeof hroom>[];
  joined?: string[];
  /** Joined ids that are themselves spaces — a child of a space may be either. */
  joinedSpaces?: string[];
  reject?: unknown;
  /** Skip `connect()`, to assert what a caller sees before the shell has wired it up. */
  skipConnect?: boolean;
}) {
  const spaceIds = new Set(opts.joinedSpaces ?? []);
  const joined = new Set([...(opts.joined ?? []), ...spaceIds]);
  const getRoomHierarchy = opts.reject
    ? vi.fn().mockRejectedValue(opts.reject)
    : vi.fn().mockResolvedValue({ rooms: opts.rooms });
  // `getRooms()` has to agree with `getRoom()`: the SDK's `getRooms()` is every room the
  // client knows, so a room the second resolves is always in the first. Returning [] here
  // while `getRoom` answered was a state the real client cannot be in — and the `joined`
  // flag is now derived from the joined-room set that `refresh()` builds off `getRooms()`.
  /** A room as `getRooms()` hands it back. Spaces also flow through `toSpace`. */
  const joinedRoom = (id: string) => ({
    roomId: id,
    name: id,
    getMyMembership: () => 'join',
    isSpaceRoom: () => spaceIds.has(id),
    getMxcAvatarUrl: () => null,
    getLiveTimeline: () => ({ getState: () => ({ getStateEvents: () => [] }) }),
  });
  const joinedRooms = [...joined].map(joinedRoom);
  /**
   * Join a room after the fact, so a test can drive a membership change. Updates BOTH
   * views the fake client offers, for the same reason the harness seeds both: a room
   * `getRooms()` lists and `getRoom()` denies is a state the real client cannot be in.
   */
  const join = (id: string) => {
    joined.add(id);
    joinedRooms.push(joinedRoom(id));
  };
  const client = {
    getRooms: () => joinedRooms,
    getRoom: (id: string) =>
      joined.has(id) ? { getMyMembership: () => 'join' } : null,
    getRoomHierarchy,
    on: vi.fn(),
    off: vi.fn(),
  };
  provideMatrix(client);
  const svc = TestBed.inject(SpacesService);
  // Connect like the shell does before any space can be opened: the `joined` flag comes
  // from the joined-room set the projection's rebuild fills in, not from a direct client
  // read inside the computed.
  if (!opts.skipConnect) {
    svc.connect();
  }
  return { svc, getRoomHierarchy, client, join };
}

/** Let `from(Promise)` settle through its microtask before asserting on signals. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('SpacesService hierarchy', () => {
  it('projects the full child set, excludes the root, orders by order then name', async () => {
    const { svc, getRoomHierarchy } = setupHierarchy({
      rooms: [
        hroom({
          roomId: '!s:hs',
          name: 'Space',
          isSpace: true,
          children: [
            { childId: '!b:hs', order: '20' },
            { childId: '!a:hs', order: '10', suggested: true },
            { childId: '!sub:hs', order: '10' }, // ties with !a on order → name breaks
          ],
        }),
        hroom({
          roomId: '!a:hs',
          name: 'alpha',
          topic: 'first',
          members: 5,
          joinRule: 'public',
          avatarUrl: 'mxc://hs/a',
        }),
        hroom({ roomId: '!b:hs', name: 'bravo', members: 2 }),
        hroom({ roomId: '!sub:hs', name: 'Sub', isSpace: true }),
      ],
      joined: ['!a:hs'],
    });

    svc.openSpace('!s:hs');
    await flush();

    expect(getRoomHierarchy).toHaveBeenCalledWith(
      '!s:hs',
      100,
      1,
      false,
      undefined, // first page — no pagination token yet
    );
    const children = svc.openSpaceChildren();
    // Root excluded; ordered by order ('10' < '20') then name ('Sub' > 'alpha').
    expect(children.map((c) => c.roomId)).toEqual([
      '!a:hs',
      '!sub:hs',
      '!b:hs',
    ]);
    expect(children[0]).toMatchObject({
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
  });

  it('orders children by code point, not by locale collation', async () => {
    // MSC1772 mandates Unicode code point order, where 'B' (66) precedes 'a' (97);
    // `localeCompare` case-folds and puts 'a' first, arranging the Organise dialog
    // differently from every other client. Names run the other way so only the order
    // field can produce this result.
    const { svc } = setupHierarchy({
      rooms: [
        hroom({
          roomId: '!s:hs',
          name: 'Space',
          isSpace: true,
          children: [
            { childId: '!upper:hs', order: 'B' },
            { childId: '!lower:hs', order: 'a' },
          ],
        }),
        hroom({ roomId: '!upper:hs', name: 'zulu' }),
        hroom({ roomId: '!lower:hs', name: 'alpha' }),
      ],
    });

    svc.openSpace('!s:hs');
    await flush();

    expect(svc.openSpaceChildren().map((c) => c.roomId)).toEqual([
      '!upper:hs',
      '!lower:hs',
    ]);
  });

  it('sorts a child with no order key after the children that have one', async () => {
    // The spec sorts children with a valid order ahead of those without, but
    // `''.localeCompare('z')` is -1, which floats the unordered child to the top.
    const { svc } = setupHierarchy({
      rooms: [
        hroom({
          roomId: '!s:hs',
          name: 'Space',
          isSpace: true,
          children: [
            { childId: '!unordered:hs' },
            { childId: '!ordered:hs', order: 'z' },
          ],
        }),
        hroom({ roomId: '!unordered:hs', name: 'alpha' }),
        hroom({ roomId: '!ordered:hs', name: 'zulu' }),
      ],
    });

    svc.openSpace('!s:hs');
    await flush();

    expect(svc.openSpaceChildren().map((c) => c.roomId)).toEqual([
      '!ordered:hs',
      '!unordered:hs',
    ]);
  });

  it('splits not-joined rooms from child spaces', async () => {
    const { svc } = setupHierarchy({
      rooms: [
        hroom({
          roomId: '!s:hs',
          name: 'Space',
          isSpace: true,
          children: [
            { childId: '!joined:hs', order: '10' },
            { childId: '!room:hs', order: '20' },
            { childId: '!sub:hs', order: '30' },
          ],
        }),
        hroom({ roomId: '!joined:hs', name: 'joined-room' }),
        hroom({ roomId: '!room:hs', name: 'open-room' }),
        hroom({ roomId: '!sub:hs', name: 'Sub Space', isSpace: true }),
      ],
      joined: ['!joined:hs'],
    });

    svc.openSpace('!s:hs');
    await flush();

    // notJoinedRooms: not joined AND not a space → only the open room.
    expect(svc.notJoinedRooms().map((c) => c.roomId)).toEqual(['!room:hs']);
    // childSpaces: every sub-space, regardless of membership.
    expect(svc.childSpaces().map((c) => c.roomId)).toEqual(['!sub:hs']);
  });

  it('flips a child to joined when its membership syncs, without re-fetching', async () => {
    // What the replaced bump counter existed for: the hierarchy fetch says who the
    // children are, sync says which of them you are in, and the second must reach the
    // screen on its own. `getRoomHierarchy` is asserted untouched because re-fetching
    // would be a different (and much more expensive) way to be right.
    const { svc, getRoomHierarchy, client, join } = setupHierarchy({
      rooms: [
        hroom({
          roomId: '!s:hs',
          name: 'Space',
          isSpace: true,
          children: [{ childId: '!room:hs', order: '10' }],
        }),
        hroom({ roomId: '!room:hs', name: 'open-room' }),
      ],
      joined: [],
    });

    svc.openSpace('!s:hs');
    await flush();
    expect(svc.notJoinedRooms().map((c) => c.roomId)).toEqual(['!room:hs']);
    const fetches = getRoomHierarchy.mock.calls.length;

    join('!room:hs');
    handlerFor(client, 'sync')?.();
    await Promise.resolve();

    expect(svc.notJoinedRooms()).toEqual([]);
    expect(svc.openSpaceChildren()[0].joined).toBe(true);
    expect(getRoomHierarchy.mock.calls.length).toBe(fetches);
  });

  it('holds the same children when a sync changes no membership', async () => {
    // The whole justification for the joined-set's structural equality. Without it every
    // ClientEvent.Sync re-derives openSpaceChildren and, through it, notJoinedRooms,
    // childSpaces, the channel sidebar and the organise dialog — for no change at all.
    const { svc, client } = setupHierarchy({
      rooms: [
        hroom({
          roomId: '!s:hs',
          name: 'Space',
          isSpace: true,
          children: [{ childId: '!room:hs', order: '10' }],
        }),
        hroom({ roomId: '!room:hs', name: 'open-room' }),
      ],
      joined: ['!room:hs'],
    });
    svc.openSpace('!s:hs');
    await flush();
    const before = svc.openSpaceChildren();

    handlerFor(client, 'sync')?.();
    await Promise.resolve();

    expect(svc.openSpaceChildren()).toBe(before);
  });

  it('counts a joined SUB-SPACE as joined, not just a room', async () => {
    // A child of a space may be either, and the joined set is built by filtering
    // `getRooms()` on membership alone — nothing there excludes spaces. Every other
    // fixture here is a plain room, so this is the only case that would notice an
    // `isSpaceRoom` filter creeping into that pass.
    const { svc } = setupHierarchy({
      rooms: [
        hroom({
          roomId: '!s:hs',
          name: 'Space',
          isSpace: true,
          children: [{ childId: '!sub:hs', order: '10' }],
        }),
        hroom({ roomId: '!sub:hs', name: 'Sub Space', isSpace: true }),
      ],
      joinedSpaces: ['!sub:hs'],
    });

    svc.openSpace('!s:hs');
    await flush();

    expect(svc.childSpaces().map((c) => c.roomId)).toEqual(['!sub:hs']);
    expect(svc.childSpaces()[0].joined).toBe(true);
  });

  it('reports children as not joined until the projection is connected', async () => {
    // A precondition the joined-set introduced: the flag comes from a set `refresh()`
    // fills, so an unconnected service says "not joined" about everything rather than
    // reading the client on the spot. The shell connects in ngOnInit, long before a space
    // can be opened — but a future caller that opens a space earlier would see this, and
    // it should be a documented answer rather than a surprise.
    const { svc } = setupHierarchy({
      rooms: [
        hroom({
          roomId: '!s:hs',
          name: 'Space',
          isSpace: true,
          children: [{ childId: '!room:hs', order: '10' }],
        }),
        hroom({ roomId: '!room:hs', name: 'open-room' }),
      ],
      joined: ['!room:hs'],
      skipConnect: true,
    });

    svc.openSpace('!s:hs');
    await flush();
    expect(svc.openSpaceChildren()[0].joined).toBe(false);

    svc.connect();

    expect(svc.openSpaceChildren()[0].joined).toBe(true);
  });

  it('clears the open-space children for Home (null) without fetching', () => {
    const { svc, getRoomHierarchy } = setupHierarchy({ rooms: [] });

    svc.openSpace(null);

    expect(getRoomHierarchy).not.toHaveBeenCalled();
    expect(svc.openSpaceChildren()).toEqual([]);
    expect(svc.childrenLoading()).toBe(false);
  });

  it('follows next_batch to fetch children beyond the first page', async () => {
    const root = hroom({
      roomId: '!s:hs',
      name: 'Space',
      isSpace: true,
      children: [
        { childId: '!a:hs', order: '10' },
        { childId: '!b:hs', order: '20' },
      ],
    });
    // Page 1 carries the root + first child and a next_batch token; page 2 the rest.
    const getRoomHierarchy = vi
      .fn()
      .mockResolvedValueOnce({
        rooms: [root, hroom({ roomId: '!a:hs', name: 'alpha' })],
        next_batch: 'tok',
      })
      .mockResolvedValueOnce({
        rooms: [hroom({ roomId: '!b:hs', name: 'bravo' })],
      });
    const client = {
      getRooms: () => [],
      getRoom: () => null,
      getRoomHierarchy,
      on: vi.fn(),
      off: vi.fn(),
    };
    provideMatrix(client);
    const svc = TestBed.inject(SpacesService);

    svc.openSpace('!s:hs');
    await flush();

    // Both pages fetched; the second passes the next_batch token through.
    expect(getRoomHierarchy).toHaveBeenCalledTimes(2);
    expect(getRoomHierarchy).toHaveBeenNthCalledWith(
      2,
      '!s:hs',
      100,
      1,
      false,
      'tok',
    );
    // Children from BOTH pages are projected — not truncated at the first 100.
    expect(svc.openSpaceChildren().map((c) => c.roomId)).toEqual([
      '!a:hs',
      '!b:hs',
    ]);
  });

  it('surfaces a hierarchy fetch failure in childrenError', async () => {
    const { svc } = setupHierarchy({
      rooms: [],
      reject: new Error('unsupported'),
    });

    svc.openSpace('!s:hs');
    await flush();

    expect(svc.childrenError()).toBe('unsupported');
    expect(svc.childrenLoading()).toBe(false);
    expect(svc.openSpaceChildren()).toEqual([]);
  });

  it('re-projects onto the newly-active account when the active account switches', () => {
    // The account-switch half of the projection: rooms.service.spec covers it for the
    // sibling read model, and this service re-wires off the same signal.
    const { svc, client, matrix } = setup([
      fakeRoom({ roomId: '!a:hs', name: 'A space', space: true }),
    ]);
    activeUserId.set('@a:hs');
    TestBed.inject(ApplicationRef).tick(); // effect's first run: still A
    expect(svc.spaces().map((s) => s.id)).toEqual(['!a:hs']);
    client.off.mockClear();

    const clientB = {
      getRooms: () => [
        fakeRoom({ roomId: '!b:hs', name: 'B space', space: true }),
      ],
      getRoom: () => null,
      on: vi.fn(),
      off: vi.fn(),
    };
    ngMocks.stubMember(matrix, 'instance', clientB as unknown as MatrixClient);
    activeUserId.set('@b:hs');
    TestBed.inject(ApplicationRef).tick();

    expect(client.off).toHaveBeenCalled(); // detached from A
    expect(clientB.on).toHaveBeenCalled(); // attached to B
    expect(svc.spaces().map((s) => s.id)).toEqual(['!b:hs']);
  });
});
