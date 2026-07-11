import { TestBed } from '@angular/core/testing';
import {
  ApplicationRef,
  NgZone,
  signal,
  type WritableSignal,
} from '@angular/core';
import { ClientEvent, MatrixEventEvent, RoomEvent } from 'matrix-js-sdk';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { RoomsService } from './rooms.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { describe, expect, it, vi } from 'vitest';

// A live-timeline event shaped like the bits messagePreview() reads.
function timelineEvent(over: {
  type?: string;
  body?: string;
  redacted?: boolean;
  decryptionFailure?: boolean;
}) {
  return {
    getType: () => over.type ?? 'm.room.message',
    getContent: () => ({ body: over.body ?? '' }),
    isRedacted: () => over.redacted ?? false,
    isDecryptionFailure: () => over.decryptionFailure ?? false,
  };
}

// A joined member shaped like the bits of matrix-js-sdk's RoomMember that
// RoomsService.toMember reads. `powerLevel` is mutable so a test can promote it.
function fakeMember(over: {
  userId: string;
  name?: string;
  avatarMxc?: string | null;
  powerLevel?: number;
}) {
  return {
    userId: over.userId,
    name: over.name ?? over.userId,
    // matrix-js-sdk's RoomMember.getMxcAvatarUrl() returns `string | undefined`.
    getMxcAvatarUrl: () => over.avatarMxc ?? undefined,
    powerLevel: over.powerLevel ?? 0,
  };
}

// Minimal fakes shaped like the bits of matrix-js-sdk that RoomsService reads.
function fakeRoom(opts: {
  roomId: string;
  name: string;
  space?: boolean;
  membership?: string;
  children?: string[];
  unread?: number;
  highlight?: number;
  activity?: number;
  encrypted?: boolean;
  favourite?: boolean;
  events?: ReturnType<typeof timelineEvent>[];
  members?: ReturnType<typeof fakeMember>[];
}) {
  return {
    roomId: opts.roomId,
    name: opts.name,
    // Mirror matrix-js-sdk's `Room.tags`; `m.favourite` drives the favourite flag.
    tags: opts.favourite ? { 'm.favourite': {} } : {},
    isSpaceRoom: () => opts.space ?? false,
    getMyMembership: () => opts.membership ?? 'join',
    getMxcAvatarUrl: () => null,
    getJoinedMemberCount: () => opts.members?.length ?? 0,
    getJoinedMembers: () => opts.members ?? [],
    hasEncryptionStateEvent: () => opts.encrypted ?? false,
    getUnreadNotificationCount: (type?: string) =>
      type === 'highlight' ? (opts.highlight ?? 0) : (opts.unread ?? 0),
    getLastActiveTimestamp: () => opts.activity ?? 0,
    getLiveTimeline: () => ({ getEvents: () => opts.events ?? [] }),
    currentState: {
      getStateEvents: (type: string, stateKey?: string) => {
        if (type === 'm.space.child' && stateKey === undefined) {
          return (opts.children ?? []).map((id) => ({ getStateKey: () => id }));
        }
        return stateKey === undefined ? [] : null;
      },
    },
  };
}

/**
 * Provide RoomsService with a MockProvider-backed MatrixClientService whose
 * `instance` getter yields `client` and whose `isInitialized` is true, matching the
 * data-holder shape the service reads. Returns both so tests can re-point `instance`.
 */
function provideRooms(client: unknown): {
  svc: RoomsService;
  matrix: MatrixClientService;
  activeUserId: WritableSignal<string | null>;
} {
  const activeUserId = signal<string | null>(null);
  TestBed.configureTestingModule({
    providers: [
      RoomsService,
      MockProvider(MatrixClientService, {
        activeUserId: activeUserId.asReadonly(),
      }),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  ngMocks.stubMember(matrix, 'isInitialized', true);
  ngMocks.stubMember(matrix, 'instance', client);
  const svc = TestBed.inject(RoomsService);
  return { svc, matrix, activeUserId };
}

describe('RoomsService', () => {
  function setup(rooms: ReturnType<typeof fakeRoom>[]) {
    const client = {
      baseUrl: 'https://hs.example',
      getRooms: () => rooms,
      on: () => {},
    };
    const { svc } = provideRooms(client);
    svc.connect();
    return svc;
  }

  it('excludes spaces and non-joined rooms from the channel list', () => {
    const svc = setup([
      fakeRoom({
        roomId: '!s:hs',
        name: 'My Space',
        space: true,
        children: ['!a:hs'],
      }),
      fakeRoom({ roomId: '!a:hs', name: 'general' }),
      fakeRoom({ roomId: '!b:hs', name: 'left', membership: 'leave' }),
    ]);

    // Spaces live in the rail (SpacesService); 'left' is filtered out too.
    expect(svc.rooms().map((r) => r.id)).toEqual(['!a:hs']);
  });

  it('tags a DM room with its counterpart user id from m.direct', () => {
    const client = {
      baseUrl: 'https://hs.example',
      getRooms: () => [
        fakeRoom({ roomId: '!dm:hs', name: 'Bob' }),
        fakeRoom({ roomId: '!room:hs', name: 'general' }),
      ],
      getAccountData: (type: string) =>
        type === 'm.direct'
          ? { getContent: () => ({ '@bob:hs': ['!dm:hs'] }) }
          : undefined,
      on: () => {},
    };
    const { svc } = provideRooms(client);
    svc.connect();

    const byId = new Map(svc.rooms().map((r) => [r.id, r] as const));
    expect(byId.get('!dm:hs')?.directUserId).toBe('@bob:hs');
    expect(byId.get('!room:hs')?.directUserId).toBeUndefined(); // plain room
  });

  it('orders rooms by recent activity and maps unread counts', () => {
    const svc = setup([
      fakeRoom({ roomId: '!old:hs', name: 'old', activity: 100 }),
      fakeRoom({
        roomId: '!new:hs',
        name: 'new',
        activity: 300,
        unread: 3,
        highlight: 1,
      }),
      fakeRoom({ roomId: '!mid:hs', name: 'mid', activity: 200 }),
    ]);

    expect(svc.rooms().map((r) => r.id)).toEqual([
      '!new:hs',
      '!mid:hs',
      '!old:hs',
    ]);
    const [newest, mid] = svc.rooms();
    expect(newest).toMatchObject({
      unreadCount: 3,
      highlightCount: 1,
      hasUnread: true,
    });
    expect(mid.hasUnread).toBe(false);
    // totalUnread is the app-wide sum of every room's unread count.
    expect(svc.totalUnread()).toBe(3);
  });

  it('marks a room read by acking its latest confirmed event', async () => {
    const latest = { getId: () => '$latest', status: null };
    const room = {
      getLiveTimeline: () => ({
        getEvents: () => [{ getId: () => '$old', status: null }, latest],
      }),
    };
    const sendReadReceipt = vi.fn().mockResolvedValue({});
    const setRoomReadMarkers = vi.fn().mockResolvedValue({});
    const client = {
      baseUrl: 'https://hs',
      getRooms: () => [],
      getRoom: () => room,
      sendReadReceipt,
      setRoomReadMarkers,
      on: () => {},
    };
    const { svc } = provideRooms(client);

    await firstValueFrom(svc.markRead('!r:hs'));

    expect(setRoomReadMarkers).toHaveBeenCalledWith('!r:hs', '$latest');
    expect(sendReadReceipt).toHaveBeenCalledWith(latest);
  });

  it('markAllRead acks only the rooms with unread', async () => {
    const latest = { getId: () => '$l', status: null };
    const room = { getLiveTimeline: () => ({ getEvents: () => [latest] }) };
    const sendReadReceipt = vi.fn().mockResolvedValue({});
    const setRoomReadMarkers = vi.fn().mockResolvedValue({});
    const client = {
      baseUrl: 'https://hs',
      getRooms: () => [
        fakeRoom({ roomId: '!a:hs', name: 'A', unread: 2 }),
        fakeRoom({ roomId: '!b:hs', name: 'B', unread: 0 }),
      ],
      getRoom: () => room,
      sendReadReceipt,
      setRoomReadMarkers,
      on: () => {},
    };
    const { svc } = provideRooms(client);
    svc.connect();

    await firstValueFrom(svc.markAllRead());

    expect(setRoomReadMarkers).toHaveBeenCalledTimes(1);
    expect(setRoomReadMarkers).toHaveBeenCalledWith('!a:hs', '$l');
  });

  it('re-projects onto the newly-active account when the active account switches', () => {
    const clientA = {
      baseUrl: 'https://a.hs',
      getRooms: () => [fakeRoom({ roomId: '!a:hs', name: 'A room' })],
      on: vi.fn(),
      off: vi.fn(),
    };
    const { svc, matrix, activeUserId } = provideRooms(clientA);
    activeUserId.set('@a:hs');
    svc.connect(); // wired to account A
    TestBed.inject(ApplicationRef).tick(); // effect's first run: still A → no-op
    expect(svc.rooms().map((r) => r.id)).toEqual(['!a:hs']);
    clientA.off.mockClear();

    // Switch: the active client becomes B; the reproject effect re-wires on the tick.
    const clientB = {
      baseUrl: 'https://b.hs',
      getRooms: () => [fakeRoom({ roomId: '!b:hs', name: 'B room' })],
      on: vi.fn(),
      off: vi.fn(),
    };
    ngMocks.stubMember(matrix, 'instance', clientB);
    activeUserId.set('@b:hs');
    TestBed.inject(ApplicationRef).tick();

    expect(clientA.off).toHaveBeenCalled(); // detached from A
    expect(clientB.on).toHaveBeenCalled(); // attached to B
    expect(svc.rooms().map((r) => r.id)).toEqual(['!b:hs']); // now B's rooms
  });

  it('derives an uppercase initial without the leading sigil', () => {
    const svc = setup([fakeRoom({ roomId: '!a:hs', name: '#general' })]);
    expect(svc.rooms()[0].initial).toBe('G');
  });

  it('previews the most recent message and skips non-message events', () => {
    const svc = setup([
      fakeRoom({
        roomId: '!a:hs',
        name: 'general',
        events: [
          timelineEvent({ body: 'older message' }),
          timelineEvent({ body: 'newest message' }),
          // A trailing state event must not be picked as the preview.
          timelineEvent({ type: 'm.room.member', body: 'joined' }),
        ],
      }),
    ]);
    expect(svc.rooms()[0].lastMessage).toBe('newest message');
  });

  it('falls back to an empty preview when a room has no messages', () => {
    const svc = setup([fakeRoom({ roomId: '!a:hs', name: 'quiet' })]);
    expect(svc.rooms()[0].lastMessage).toBe('');
  });

  it('flags rooms with encryption enabled', () => {
    const svc = setup([
      fakeRoom({ roomId: '!e:hs', name: 'secret', encrypted: true }),
      fakeRoom({ roomId: '!p:hs', name: 'public' }),
    ]);
    const byId = Object.fromEntries(
      svc.rooms().map((r) => [r.id, r.encrypted]),
    );
    expect(byId['!e:hs']).toBe(true);
    expect(byId['!p:hs']).toBe(false);
  });

  it('flags a room carrying the m.favourite tag as favourite', () => {
    const svc = setup([
      fakeRoom({ roomId: '!f:hs', name: 'starred', favourite: true }),
      fakeRoom({ roomId: '!p:hs', name: 'plain' }),
    ]);
    const byId = Object.fromEntries(
      svc.rooms().map((r) => [r.id, r.favourite]),
    );
    expect(byId['!f:hs']).toBe(true);
    expect(byId['!p:hs']).toBe(false);
  });

  it('floats a favourite room above a more recently active non-favourite one', () => {
    const svc = setup([
      // Most recently active, but not favourited.
      fakeRoom({ roomId: '!new:hs', name: 'zulu', activity: 500 }),
      // Older, but favourited — favourite-first beats activityTs.
      fakeRoom({
        roomId: '!fav:hs',
        name: 'alpha',
        activity: 100,
        favourite: true,
      }),
      fakeRoom({ roomId: '!old:hs', name: 'bravo', activity: 50 }),
    ]);
    expect(svc.rooms().map((r) => r.id)).toEqual([
      '!fav:hs',
      '!new:hs',
      '!old:hs',
    ]);
  });

  it('falls back to name when two favourite rooms tie on activity', () => {
    const svc = setup([
      fakeRoom({
        roomId: '!z:hs',
        name: 'zulu',
        activity: 100,
        favourite: true,
      }),
      fakeRoom({
        roomId: '!a:hs',
        name: 'alpha',
        activity: 100,
        favourite: true,
      }),
    ]);
    expect(svc.rooms().map((r) => r.id)).toEqual(['!a:hs', '!z:hs']);
  });

  it('rewires onto a new client after re-login instead of freezing', () => {
    const makeClient = (rooms: ReturnType<typeof fakeRoom>[]) => ({
      baseUrl: 'https://hs.example',
      getRooms: () => rooms,
      on: vi.fn(),
      off: vi.fn(),
    });
    const clientA = makeClient([fakeRoom({ roomId: '!a:hs', name: 'A' })]);
    const clientB = makeClient([fakeRoom({ roomId: '!b:hs', name: 'B' })]);
    const { svc, matrix } = provideRooms(clientA);

    svc.connect();
    expect(svc.rooms().map((r) => r.id)).toEqual(['!a:hs']);

    // Simulate logout→login: MatrixClientService swaps in a fresh client.
    ngMocks.stubMember(matrix, 'instance', clientB);
    svc.connect();

    expect(svc.rooms().map((r) => r.id)).toEqual(['!b:hs']); // not frozen on A
    expect(clientA.off).toHaveBeenCalled(); // old listeners detached
    expect(clientB.on).toHaveBeenCalled(); // new client wired
  });

  it('recomputes totalUnread when a sync event refreshes an updated unread count', async () => {
    // A mutable "room" so the fake client can report a bumped unread count on
    // the next refresh, the same way a real Room's counters change in place.
    const unread = { count: 2 };
    const room = fakeRoom({ roomId: '!a:hs', name: 'a' });
    room.getUnreadNotificationCount = (type?: string) =>
      type === 'highlight' ? 0 : unread.count;
    const handlers = new Map<string, () => void>();
    const client = {
      baseUrl: 'https://hs.example',
      getRooms: () => [room],
      on: (event: string, cb: () => void) => handlers.set(event, cb),
      off: vi.fn(),
    };
    const { svc } = provideRooms(client);
    svc.connect();
    expect(svc.totalUnread()).toBe(2);

    unread.count = 9; // e.g. a new message arrives
    handlers.get(ClientEvent.Sync)?.(); // sync fires; refresh is coalesced onto a microtask
    await Promise.resolve();

    expect(svc.totalUnread()).toBe(9);
  });

  it('refreshes unread on MatrixEventEvent.Decrypted (encrypted message decrypts late)', async () => {
    const unread = { count: 0 };
    const room = fakeRoom({ roomId: '!a:hs', name: 'a' });
    room.getUnreadNotificationCount = (type?: string) =>
      type === 'highlight' ? 0 : unread.count;
    const handlers = new Map<string, () => void>();
    const client = {
      baseUrl: 'https://hs.example',
      getRooms: () => [room],
      on: (event: string, cb: () => void) => handlers.set(event, cb),
      off: vi.fn(),
    };
    const { svc } = provideRooms(client);
    svc.connect();
    expect(svc.totalUnread()).toBe(0);

    // The count only settles once the ciphertext decrypts, which fires Decrypted
    // (not a fresh Sync) — relying on Sync alone would drop the increment.
    unread.count = 1;
    handlers.get(MatrixEventEvent.Decrypted)?.();
    await Promise.resolve();

    expect(svc.totalUnread()).toBe(1);
  });

  it('runs listener-driven refreshes inside the Angular zone (badges surface immediately)', async () => {
    const room = fakeRoom({ roomId: '!a:hs', name: 'a' });
    const handlers = new Map<string, () => void>();
    const client = {
      baseUrl: 'https://hs.example',
      getRooms: () => [room],
      on: (event: string, cb: () => void) => handlers.set(event, cb),
      off: vi.fn(),
    };
    const { svc } = provideRooms(client);
    const zone = TestBed.inject(NgZone);
    svc.connect();

    // Matrix client events fire OUTSIDE Angular's zone; the coalesced refresh must
    // re-enter it, or change detection (and the rail + dock unread badges) wouldn't
    // run until the next incidental tick — up to a ~30s /sync poll later.
    const runSpy = vi.spyOn(zone, 'run');
    handlers.get(ClientEvent.Sync)?.();
    await Promise.resolve();

    expect(runSpy).toHaveBeenCalled();
  });

  it('recomputes totalUnread when a room is added to the synced list', async () => {
    let currentRooms = [fakeRoom({ roomId: '!a:hs', name: 'a', unread: 2 })];
    const handlers = new Map<string, () => void>();
    const client = {
      baseUrl: 'https://hs.example',
      getRooms: () => currentRooms,
      on: (event: string, cb: () => void) => handlers.set(event, cb),
      off: vi.fn(),
    };
    const { svc } = provideRooms(client);
    svc.connect();
    expect(svc.totalUnread()).toBe(2);

    currentRooms = [
      ...currentRooms,
      fakeRoom({ roomId: '!b:hs', name: 'b', unread: 5 }),
    ];
    handlers.get(ClientEvent.Room)?.();
    await Promise.resolve();

    expect(svc.rooms().map((r) => r.id)).toEqual(['!a:hs', '!b:hs']);
    expect(svc.totalUnread()).toBe(7);
  });

  it('ignores a repeat connect() for the same client', () => {
    const client = {
      baseUrl: 'https://hs.example',
      getRooms: () => [],
      on: vi.fn(),
      off: vi.fn(),
    };
    const { svc } = provideRooms(client);

    svc.connect();
    const wiredCalls = client.on.mock.calls.length;
    svc.connect();

    expect(client.on.mock.calls.length).toBe(wiredCalls); // no double-wiring
  });
});

// Write paths: createRoom / createDirectMessage / inviteUser / searchUsers. The
// read model is driven by sync listeners (covered above), so these assert the SDK
// calls + the `m.direct` merge only.
describe('RoomsService writes', () => {
  // `direct` seeds the `m.direct` account-data map; `joinedRooms` are the rooms a
  // DM-reuse lookup can resolve (with their membership).
  function setupWrites(opts?: {
    direct?: Record<string, string[]>;
    joinedRooms?: Record<string, string>; // roomId -> membership
  }) {
    const createRoom = vi.fn().mockResolvedValue({ room_id: '!new:hs' });
    const invite = vi.fn().mockResolvedValue({});
    const setAccountData = vi.fn().mockResolvedValue({});
    const searchUserDirectory = vi.fn().mockResolvedValue({
      results: [
        { user_id: '@bob:hs', display_name: 'Bob', avatar_url: 'mxc://a/b' },
        { user_id: '@eve:hs' }, // no display name / avatar
      ],
    });
    const membershipById = opts?.joinedRooms ?? {};
    const getRoomIdForAlias = vi
      .fn()
      .mockResolvedValue({ room_id: '!aliased:hs' });
    const leave = vi.fn().mockResolvedValue({});
    const client = {
      getRooms: () => [],
      getRoom: (id: string) =>
        membershipById[id]
          ? { getMyMembership: () => membershipById[id] }
          : null,
      getAccountData: (type: string) =>
        type === 'm.direct'
          ? { getContent: () => opts?.direct ?? {} }
          : undefined,
      createRoom,
      invite,
      setAccountData,
      searchUserDirectory,
      getRoomIdForAlias,
      leave,
      on: vi.fn(),
      off: vi.fn(),
    };
    const { svc } = provideRooms(client);
    return {
      svc,
      createRoom,
      invite,
      setAccountData,
      searchUserDirectory,
      getRoomIdForAlias,
      leave,
    };
  }

  it('resolveRoomId passes a room id through without a lookup', async () => {
    const { svc, getRoomIdForAlias } = setupWrites();
    expect(await firstValueFrom(svc.resolveRoomId('!r:hs'))).toBe('!r:hs');
    expect(getRoomIdForAlias).not.toHaveBeenCalled();
  });

  it('resolveRoomId looks up a room alias on the homeserver', async () => {
    const { svc, getRoomIdForAlias } = setupWrites();
    expect(await firstValueFrom(svc.resolveRoomId('#general:hs'))).toBe(
      '!aliased:hs',
    );
    expect(getRoomIdForAlias).toHaveBeenCalledWith('#general:hs');
  });

  it('createRoom creates an encrypted, invite-only room and resolves its id', async () => {
    const { svc, createRoom } = setupWrites();

    const id = await firstValueFrom(svc.createRoom({ name: '  general  ' }));

    expect(id).toBe('!new:hs');
    expect(createRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'general', // trimmed
        visibility: 'private',
        preset: 'private_chat',
        initial_state: [
          {
            type: 'm.room.encryption',
            state_key: '',
            content: { algorithm: 'm.megolm.v1.aes-sha2' },
          },
        ],
      }),
    );
  });

  it('leave is cold and leaves the room on subscribe', async () => {
    const { svc, leave } = setupWrites();

    const action = svc.leave('!r:hs');
    expect(leave).not.toHaveBeenCalled(); // cold — nothing until subscribed

    await firstValueFrom(action);
    expect(leave).toHaveBeenCalledWith('!r:hs');
  });

  it('leave surfaces a homeserver failure to the subscriber', async () => {
    const { svc, leave } = setupWrites();
    leave.mockRejectedValue(new Error('M_FORBIDDEN'));

    await expect(firstValueFrom(svc.leave('!r:hs'))).rejects.toThrow(
      'M_FORBIDDEN',
    );
  });

  it('createDirectMessage creates an encrypted DM and records it in m.direct', async () => {
    const { svc, createRoom, setAccountData } = setupWrites();

    const id = await firstValueFrom(svc.createDirectMessage('@bob:hs'));

    expect(id).toBe('!new:hs');
    expect(createRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        is_direct: true,
        invite: ['@bob:hs'],
        preset: 'trusted_private_chat',
        initial_state: [
          {
            type: 'm.room.encryption',
            state_key: '',
            content: { algorithm: 'm.megolm.v1.aes-sha2' },
          },
        ],
      }),
    );
    // The new room is merged into m.direct under the invitee.
    expect(setAccountData).toHaveBeenCalledWith('m.direct', {
      '@bob:hs': ['!new:hs'],
    });
  });

  it('createDirectMessage reuses a joined DM and writes nothing', async () => {
    const { svc, createRoom, setAccountData } = setupWrites({
      direct: { '@bob:hs': ['!existing:hs'] },
      joinedRooms: { '!existing:hs': 'join' },
    });

    const id = await firstValueFrom(svc.createDirectMessage('@bob:hs'));

    expect(id).toBe('!existing:hs');
    expect(createRoom).not.toHaveBeenCalled();
    expect(setAccountData).not.toHaveBeenCalled();
  });

  it('createDirectMessage ignores a left DM and creates + appends a new one', async () => {
    const { svc, createRoom, setAccountData } = setupWrites({
      direct: { '@bob:hs': ['!left:hs'] },
      joinedRooms: { '!left:hs': 'leave' },
    });

    const id = await firstValueFrom(svc.createDirectMessage('@bob:hs'));

    expect(id).toBe('!new:hs');
    expect(createRoom).toHaveBeenCalled();
    // The new room is appended; the stale (left) id is preserved in the map.
    expect(setAccountData).toHaveBeenCalledWith('m.direct', {
      '@bob:hs': ['!left:hs', '!new:hs'],
    });
  });

  it('createDirectMessage merges against m.direct re-read after createRoom (no lost update)', async () => {
    // m.direct starts empty; a concurrent device records a DM with someone else
    // *while* createRoom is in flight. Because the write re-reads the freshest
    // map (not a pre-createRoom snapshot), that entry must survive the PUT.
    const directMap: Record<string, string[]> = {};
    const setAccountData = vi.fn().mockResolvedValue({});
    const createRoom = vi.fn().mockImplementation(async () => {
      directMap['@carol:hs'] = ['!carol-dm:hs']; // arrives mid-flight via sync
      return { room_id: '!new:hs' };
    });
    const client = {
      getRooms: () => [],
      getRoom: () => null,
      getAccountData: (type: string) =>
        type === 'm.direct' ? { getContent: () => directMap } : undefined,
      createRoom,
      setAccountData,
      on: vi.fn(),
      off: vi.fn(),
    };
    const { svc } = provideRooms(client);

    await firstValueFrom(svc.createDirectMessage('@bob:hs'));

    // The PUT keeps the concurrent entry and adds the new DM — nothing clobbered.
    expect(setAccountData).toHaveBeenCalledWith('m.direct', {
      '@carol:hs': ['!carol-dm:hs'],
      '@bob:hs': ['!new:hs'],
    });
  });

  it('createDirectMessage rejects an invalid user id without creating', async () => {
    const { svc, createRoom } = setupWrites();

    await expect(
      firstValueFrom(svc.createDirectMessage('not-a-mxid')),
    ).rejects.toThrow();
    expect(createRoom).not.toHaveBeenCalled();
  });

  it('inviteUser invites the user to the room (works for spaces too)', async () => {
    const { svc, invite } = setupWrites();

    await firstValueFrom(svc.inviteUser('!r:hs', '@bob:hs'));

    expect(invite).toHaveBeenCalledWith('!r:hs', '@bob:hs');
  });

  it('inviteUser rejects an invalid user id without calling invite', async () => {
    const { svc, invite } = setupWrites();

    await expect(
      firstValueFrom(svc.inviteUser('!r:hs', '@bob')),
    ).rejects.toThrow();
    expect(invite).not.toHaveBeenCalled();
  });

  it('searchUsers maps directory results, falling back to the user id', async () => {
    const { svc } = setupWrites();

    const results = await firstValueFrom(svc.searchUsers('b'));

    expect(results).toEqual([
      { userId: '@bob:hs', displayName: 'Bob', avatarMxc: 'mxc://a/b' },
      { userId: '@eve:hs', displayName: '@eve:hs', avatarMxc: null },
    ]);
  });

  it('searchUsers short-circuits an empty term without a request', async () => {
    const { svc, searchUserDirectory } = setupWrites();

    const results = await firstValueFrom(svc.searchUsers('   '));

    expect(results).toEqual([]);
    expect(searchUserDirectory).not.toHaveBeenCalled();
  });
});

// directRoomIds flattens the `m.direct` account-data map on each sync refresh so the
// read model can tag joined DMs without re-reading account data.
describe('RoomsService directRoomIds', () => {
  function setup(direct: Record<string, string[]> | undefined): RoomsService {
    const client = {
      getRooms: () => [],
      getAccountData: (type: string) =>
        type === 'm.direct' ? { getContent: () => direct ?? {} } : undefined,
      on: vi.fn(),
      off: vi.fn(),
    };
    const { svc } = provideRooms(client);
    svc.connect();
    return svc;
  }

  it('flattens every DM room id from m.direct', () => {
    const svc = setup({
      '@bob:hs': ['!dm1:hs'],
      '@eve:hs': ['!dm2:hs', '!dm3:hs'],
    });

    expect([...svc.directRoomIds()].sort()).toEqual([
      '!dm1:hs',
      '!dm2:hs',
      '!dm3:hs',
    ]);
  });

  it('yields an empty set when m.direct is empty', () => {
    expect(setup({}).directRoomIds().size).toBe(0);
  });
});

// setFavourite writes/clears the `m.favourite` room tag; the read model refreshes
// once the write resolves. A remote favourite change (another device) arrives as a
// RoomEvent.Tags on the client and is coalesced into a refresh like any other listener.
describe('RoomsService setFavourite', () => {
  function setup(initialFavourite: boolean) {
    let currentRooms = [
      fakeRoom({
        roomId: '!a:hs',
        name: 'general',
        favourite: initialFavourite,
      }),
    ];
    const setRoomTag = vi.fn().mockResolvedValue({});
    const deleteRoomTag = vi.fn().mockResolvedValue({});
    const handlers = new Map<string, () => void>();
    const client = {
      getRooms: () => currentRooms,
      setRoomTag,
      deleteRoomTag,
      on: (event: string, cb: () => void) => handlers.set(event, cb),
      off: vi.fn(),
    };
    const { svc } = provideRooms(client);
    svc.connect();
    return {
      svc,
      setRoomTag,
      deleteRoomTag,
      handlers,
      setRooms: (rooms: ReturnType<typeof fakeRoom>[]) => {
        currentRooms = rooms;
      },
    };
  }

  it('favouriting a room writes the m.favourite tag and refreshes on resolve', async () => {
    const { svc, setRoomTag, deleteRoomTag, setRooms } = setup(false);
    // The real server would now report the tag on the next read; simulate that
    // so the post-write refresh picks up the change.
    setRooms([fakeRoom({ roomId: '!a:hs', name: 'general', favourite: true })]);

    svc.setFavourite('!a:hs', true);
    await Promise.resolve();
    await Promise.resolve();

    expect(setRoomTag).toHaveBeenCalledWith('!a:hs', 'm.favourite', {});
    expect(deleteRoomTag).not.toHaveBeenCalled();
    expect(svc.rooms()[0].favourite).toBe(true);
  });

  it('unfavouriting a room deletes the m.favourite tag and refreshes on resolve', async () => {
    const { svc, setRoomTag, deleteRoomTag, setRooms } = setup(true);
    setRooms([
      fakeRoom({ roomId: '!a:hs', name: 'general', favourite: false }),
    ]);

    svc.setFavourite('!a:hs', false);
    await Promise.resolve();
    await Promise.resolve();

    expect(deleteRoomTag).toHaveBeenCalledWith('!a:hs', 'm.favourite');
    expect(setRoomTag).not.toHaveBeenCalled();
    expect(svc.rooms()[0].favourite).toBe(false);
  });

  it('rebuilds the list on a RoomEvent.Tags (remote favourite change from another device)', async () => {
    const { svc, handlers, setRooms } = setup(false);
    expect(svc.rooms()[0].favourite).toBe(false);

    setRooms([fakeRoom({ roomId: '!a:hs', name: 'general', favourite: true })]);
    handlers.get(RoomEvent.Tags)?.();
    await Promise.resolve();

    expect(svc.rooms()[0].favourite).toBe(true);
  });
});

// membersOf projects a room's joined members (with power level) into the member-list
// view model, memoized against a per-room fingerprint that includes each power level.
describe('RoomsService membersOf', () => {
  function setup(room: ReturnType<typeof fakeRoom>): RoomsService {
    const client = {
      getRooms: () => [room],
      getRoom: (id: string) => (id === room.roomId ? room : null),
      on: vi.fn(),
      off: vi.fn(),
    };
    const { svc } = provideRooms(client);
    svc.connect();
    return svc;
  }

  it('returns joined members name-sorted, each carrying its power level and avatar', () => {
    const svc = setup(
      fakeRoom({
        roomId: '!a:hs',
        name: 'general',
        members: [
          fakeMember({ userId: '@z:hs', name: 'Zoe', powerLevel: 50 }),
          fakeMember({
            userId: '@a:hs',
            name: 'Ada',
            powerLevel: 100,
            avatarMxc: 'mxc://hs/ada',
          }),
        ],
      }),
    );

    const list = svc.membersOf('!a:hs');
    expect(list.map((m) => m.name)).toEqual(['Ada', 'Zoe']);
    expect(list.map((m) => m.powerLevel)).toEqual([100, 50]);
    // An absent avatar normalises to null; a present one is carried through.
    expect(list.map((m) => m.avatarMxc)).toEqual(['mxc://hs/ada', null]);
    expect(list[0].initial).toBe('A');
  });

  it('re-projects when a member power level changes (fingerprint invalidates the cache)', () => {
    const member = fakeMember({ userId: '@a:hs', name: 'Ada', powerLevel: 0 });
    const svc = setup(
      fakeRoom({ roomId: '!a:hs', name: 'general', members: [member] }),
    );
    expect(svc.membersOf('!a:hs')[0].powerLevel).toBe(0);

    member.powerLevel = 100; // promoted to admin
    expect(svc.membersOf('!a:hs')[0].powerLevel).toBe(100);
  });
});
