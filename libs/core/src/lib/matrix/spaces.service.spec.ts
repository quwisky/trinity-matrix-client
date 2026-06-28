import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { SpacesService } from './spaces.service';
import { MatrixClientService } from './matrix-client.service';

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
    currentState: {
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
    },
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
  const matrix = {
    isInitialized: true,
    instance: client,
  } as unknown as MatrixClientService;

  TestBed.configureTestingModule({
    providers: [
      SpacesService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  const svc = TestBed.inject(SpacesService);
  svc.connect();
  return { svc, client, matrix };
}

/** Pull a captured client listener by event name (for simulating live updates). */
function handlerFor(client: { on: ReturnType<typeof vi.fn> }, event: string) {
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

  it('refreshes live when a child link arrives (RoomState.events)', () => {
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

    expect(svc.childRoomIds('!s:hs')).toEqual(['!a:hs', '!b:hs']);
  });

  it('ignores unrelated state events', () => {
    const { svc, client } = setup([
      fakeRoom({ roomId: '!s:hs', name: 'Space', space: true }),
    ]);
    const onState = handlerFor(client, 'RoomState.events');

    onState?.({ getType: () => 'm.room.topic' });

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
    (matrix as unknown as { instance: unknown }).instance = clientB;
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
