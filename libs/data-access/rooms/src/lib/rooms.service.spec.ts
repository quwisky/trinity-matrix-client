import { TestBed } from '@angular/core/testing';
import { ApplicationRef, signal, type WritableSignal } from '@angular/core';
import {
  type MatrixClient,
  ClientEvent,
  MatrixEventEvent,
  ReceiptType,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
} from 'matrix-js-sdk';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { RoomsService } from './rooms.service';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { PrivacySettingsService } from '@trinity/platform-native';
import { describe, expect, it, type Mock, vi } from 'vitest';

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
  membership?: string;
}) {
  return {
    userId: over.userId,
    name: over.name ?? over.userId,
    // matrix-js-sdk's RoomMember.getMxcAvatarUrl() returns `string | undefined`.
    getMxcAvatarUrl: () => over.avatarMxc ?? undefined,
    powerLevel: over.powerLevel ?? 0,
    membership: over.membership ?? 'join',
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
  lowPriority?: boolean;
  /** Widened past `timelineEvent`: markRead also reads an event's id and send status. */
  events?: (ReturnType<typeof timelineEvent> & {
    getId?: () => string;
    status?: string | null;
  })[];
  members?: ReturnType<typeof fakeMember>[];
  creator?: string | null;
  /** Avatar of the member the SDK offers as a stand-in for a room with ≤2 members. */
  peerAvatarMxc?: string;
  /** The room's `m.marked_unread` content, if it has any. */
  markedUnread?: { unread: boolean };
  /** The same flag under the legacy unstable type some clients still write. */
  legacyMarkedUnread?: { unread: boolean };
}) {
  return {
    roomId: opts.roomId,
    name: opts.name,
    // Mirror matrix-js-sdk's `Room.tags`; `m.favourite` and `m.lowpriority` drive the
    // favourite and low-priority flags.
    tags: {
      ...(opts.favourite ? { 'm.favourite': {} } : {}),
      ...(opts.lowPriority ? { 'm.lowpriority': {} } : {}),
    },
    isSpaceRoom: () => opts.space ?? false,
    getMyMembership: () => opts.membership ?? 'join',
    getMxcAvatarUrl: () => null,
    getAccountData: (type: string) => {
      const content =
        type === 'm.marked_unread'
          ? opts.markedUnread
          : type === 'com.famedly.marked_unread'
            ? opts.legacyMarkedUnread
            : undefined;
      return content ? { getContent: () => content } : undefined;
    },
    // Modelled honestly: the SDK hands back a stand-in member for ANY room with two or
    // fewer members, DM or not (room.js:761 bails out only above two). Returning
    // `undefined` for group rooms here would make the guard untestable — the fake, not
    // the code, would be producing the initial.
    getAvatarFallbackMember: () =>
      opts.peerAvatarMxc
        ? { getMxcAvatarUrl: () => opts.peerAvatarMxc }
        : undefined,
    getJoinedMemberCount: () => opts.members?.length ?? 0,
    getJoinedMembers: () => opts.members ?? [],
    getCreator: () => opts.creator ?? null,
    hasEncryptionStateEvent: () => opts.encrypted ?? false,
    getUnreadNotificationCount: (type?: string) =>
      type === 'highlight' ? (opts.highlight ?? 0) : (opts.unread ?? 0),
    getLastActiveTimestamp: () => opts.activity ?? 0,
    // Room state hangs off the live timeline (what liveRoomState() reads, and what
    // the SDK's deprecated `currentState` aliased).
    getLiveTimeline: () => ({
      getEvents: () => opts.events ?? [],
      getState: () => ({
        getStateEvents: (type: string, stateKey?: string) => {
          if (type === 'm.space.child' && stateKey === undefined) {
            return (opts.children ?? []).map((id) => ({
              getStateKey: () => id,
            }));
          }
          return stateKey === undefined ? [] : null;
        },
      }),
    }),
  };
}

/**
 * The fakes below implement only the slice of MatrixClient the service touches, so the
 * widening cast lives here — one visible seam — rather than being repeated, implicit,
 * at every stub site.
 */
const asClient = (fake: object): MatrixClient =>
  fake as unknown as MatrixClient;

/**
 * Provide RoomsService with a MockProvider-backed MatrixClientService whose
 * `instance` getter yields `client` and whose `isInitialized` is true, matching the
 * data-holder shape the service reads. Returns both so tests can re-point `instance`.
 */
function provideRooms(
  client: object,
  sendReadReceipts = true,
): {
  svc: RoomsService;
  matrix: MatrixClientService;
  activeUserId: WritableSignal<string | null>;
} {
  const activeUserId = signal<string | null>(null);
  TestBed.configureTestingModule({
    providers: [
      RoomsService,
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
      MockProvider(PrivacySettingsService, {
        sendReadReceipts: signal(sendReadReceipts).asReadonly(),
      }),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  ngMocks.stubMember(matrix, 'isInitialized', true);
  ngMocks.stubMember(matrix, 'instance', asClient(client));
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

  it("shows the other person's avatar for a DM that has no room avatar", () => {
    // A DM is never given an `m.room.avatar`, so reading only that state event left
    // every 1:1 conversation showing a coloured initial beside a name that had
    // resolved to the person perfectly well.
    //
    // BOTH rooms here offer a stand-in member, exactly as the SDK does for any room of
    // two or fewer; only `m.direct` separates them. That is the point — a two-person
    // named group room must keep its initial rather than wear that member's face and
    // then lose it again the moment a third person joins.
    const client = {
      baseUrl: 'https://hs.example',
      getRooms: () => [
        fakeRoom({
          roomId: '!dm:hs',
          name: 'Bob',
          peerAvatarMxc: 'mxc://hs/bob',
        }),
        fakeRoom({
          roomId: '!pair:hs',
          name: 'planning',
          peerAvatarMxc: 'mxc://hs/colleague',
        }),
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
    expect(byId.get('!dm:hs')?.avatarMxc).toBe('mxc://hs/bob');
    expect(byId.get('!pair:hs')?.avatarMxc).toBeNull();
  });

  it("rebuilds the room list when a DM peer's avatar arrives late", async () => {
    // The DM row's picture IS the peer's member, so the room list depends on member
    // state now. Those listeners are deliberately kept out of the coalesced rebuild —
    // they drive `memberRevision` alone — which left a DM peer's late-arriving profile
    // (a member-list load, say) invisible until the next sync happened along.
    // Mutable so the peer's profile can "arrive" mid-test, the way lazy member loading
    // delivers it after the room list has already been built.
    const peer: { avatarMxc?: string } = {};
    let getRoomsCalls = 0;
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const client = {
      baseUrl: 'https://hs.example',
      getRooms: () => {
        getRoomsCalls++;
        return [
          fakeRoom({
            roomId: '!dm:hs',
            name: 'Bob',
            peerAvatarMxc: peer.avatarMxc,
          }),
        ];
      },
      getAccountData: (type: string) =>
        type === 'm.direct'
          ? { getContent: () => ({ '@bob:hs': ['!dm:hs'] }) }
          : undefined,
      on: (event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      },
    };
    const { svc } = provideRooms(client);
    svc.connect();
    expect(svc.rooms()[0].avatarMxc).toBeNull();

    // A member event for someone we have no DM with must NOT rebuild the whole list.
    const callsBefore = getRoomsCalls;
    handlers.get(RoomStateEvent.Members)?.({}, {}, { userId: '@stranger:hs' });
    await Promise.resolve();
    expect(getRoomsCalls).toBe(callsBefore);

    peer.avatarMxc = 'mxc://hs/bob';
    handlers.get(RoomStateEvent.Members)?.({}, {}, { userId: '@bob:hs' });
    await Promise.resolve(); // the rebuild is coalesced into a microtask

    expect(svc.rooms()[0].avatarMxc).toBe('mxc://hs/bob');
  });

  describe('marked unread', () => {
    it('reads the flag as unread even with nothing new in the room', () => {
      // The whole point: the read receipt does not move, so the server's counts stay at
      // zero and this flag is the only thing saying the room still wants attention.
      const svc = setup([
        fakeRoom({
          roomId: '!flagged:hs',
          name: 'Flagged',
          markedUnread: { unread: true },
        }),
        fakeRoom({ roomId: '!plain:hs', name: 'Plain' }),
      ]);

      const byId = new Map(svc.rooms().map((r) => [r.id, r] as const));
      expect(byId.get('!flagged:hs')).toMatchObject({
        markedUnread: true,
        hasUnread: true,
        unreadCount: 0,
      });
      expect(byId.get('!plain:hs')).toMatchObject({
        markedUnread: false,
        hasUnread: false,
      });
    });

    it('reads the legacy unstable event type other clients still write', () => {
      const svc = setup([
        fakeRoom({
          roomId: '!r:hs',
          name: 'R',
          legacyMarkedUnread: { unread: true },
        }),
      ]);

      expect(svc.rooms()[0].markedUnread).toBe(true);
    });

    /** A client that records account-data writes and can hold rooms per account. */
    function setupWritable(rooms: ReturnType<typeof fakeRoom>[]) {
      const setRoomAccountData = vi.fn(() => Promise.resolve({}));
      const client = {
        baseUrl: 'https://hs.example',
        getRooms: () => rooms,
        getRoom: (id: string) => rooms.find((r) => r.roomId === id),
        setRoomAccountData,
        on: () => {},
      };
      const { svc, matrix } = provideRooms(client);
      ngMocks.stubMember(matrix, 'accountIds', signal(['@me:hs']).asReadonly());
      ngMocks.stubMember(matrix, 'clientFor', (() => client) as never);
      svc.connect();
      return { svc, client, setRoomAccountData };
    }

    it('writes the STABLE event type when flagging a room', async () => {
      // Both types are read, but only the stable one is written — writing the legacy
      // prefix would spread it further rather than letting it die out.
      const { svc, setRoomAccountData } = setupWritable([
        fakeRoom({ roomId: '!r:hs', name: 'R' }),
      ]);

      await firstValueFrom(svc.setMarkedUnread('!r:hs', true));

      expect(setRoomAccountData).toHaveBeenCalledWith(
        '!r:hs',
        'm.marked_unread',
        {
          unread: true,
        },
      );
    });

    it('shows the flag before the server confirms it', async () => {
      // `setRoomAccountData` is a bare PUT with no local echo and `Room.accountData` is
      // only written from /sync, so a post-write refresh alone re-reads the OLD value —
      // the row would not change until the sync echo arrived, and the click would look
      // like it did nothing.
      const { svc } = setupWritable([fakeRoom({ roomId: '!r:hs', name: 'R' })]);
      expect(svc.rooms()[0].markedUnread).toBe(false);

      await firstValueFrom(svc.setMarkedUnread('!r:hs', true));

      expect(svc.rooms()[0]).toMatchObject({
        markedUnread: true,
        hasUnread: true,
      });
    });

    it('puts the row back when the write is rejected', async () => {
      const { svc, setRoomAccountData } = setupWritable([
        fakeRoom({ roomId: '!r:hs', name: 'R' }),
      ]);
      setRoomAccountData.mockRejectedValue(new Error('offline'));

      await expect(
        firstValueFrom(svc.setMarkedUnread('!r:hs', true)),
      ).rejects.toThrow('offline');

      expect(svc.rooms()[0].markedUnread).toBe(false);
    });

    it('hands ownership back to the server once /sync agrees', async () => {
      // The optimistic value must not shadow the account indefinitely: once the synced
      // room says the same thing, the overlay is dropped so a change made on another
      // device is not fought by a stale local guess.
      const room = fakeRoom({ roomId: '!r:hs', name: 'R' });
      const { svc } = setupWritable([room]);
      await firstValueFrom(svc.setMarkedUnread('!r:hs', true));

      // The sync echo lands: the room itself now says flagged, matching the overlay.
      room.getAccountData = (type: string) =>
        type === 'm.marked_unread'
          ? { getContent: () => ({ unread: true }) }
          : undefined;
      await firstValueFrom(svc.setMarkedUnread('!r:hs', true)); // any rebuild
      expect(svc.rooms()[0].markedUnread).toBe(true);

      // Another device clears it. With the overlay dropped, the server wins.
      room.getAccountData = () => undefined;
      await firstValueFrom(svc.setMarkedUnread('!other:hs', true));
      expect(svc.rooms()[0].markedUnread).toBe(false);
    });

    it('still clears the flag when the room has nothing to acknowledge', async () => {
      // The clear runs BEFORE markRead's early return for a room with no ackable event.
      // A flagged empty room marked read must stop being flagged; ordering it after the
      // return would leave the only way out of the flag not working on an empty room.
      const room = fakeRoom({
        roomId: '!r:hs',
        name: 'R',
        markedUnread: { unread: true },
      });
      const setRoomAccountData = vi.fn(() => Promise.resolve({}));
      const sendReadReceipt = vi.fn(() => Promise.resolve({}));
      const client = {
        baseUrl: 'https://hs.example',
        getRooms: () => [room],
        getRoom: () => room,
        setRoomAccountData,
        sendReadReceipt,
        on: () => {},
      };
      const { svc } = provideRooms(client);
      svc.connect();

      await firstValueFrom(svc.markRead('!r:hs'));

      expect(setRoomAccountData).toHaveBeenCalledWith(
        '!r:hs',
        'm.marked_unread',
        { unread: false },
      );
      expect(sendReadReceipt).not.toHaveBeenCalled(); // nothing to ack
    });

    it('sweeps every account and writes only where the flag is set', async () => {
      // A merged mixed-account row can be flagged on either side; clearing only the
      // active account would leave it flagged with no way for the user to fix it. The
      // guard is what keeps this cheap enough to call on every room open.
      const mine = fakeRoom({ roomId: '!r:hs', name: 'R' });
      const theirs = fakeRoom({
        roomId: '!r:hs',
        name: 'R',
        markedUnread: { unread: true },
      });
      const write = { mine: vi.fn(), theirs: vi.fn() };
      const clients: Record<string, object> = {
        '@me:hs': {
          getRooms: () => [mine],
          getRoom: () => mine,
          setRoomAccountData: write.mine.mockReturnValue(Promise.resolve({})),
          on: () => {},
        },
        '@other:hs': {
          getRooms: () => [theirs],
          getRoom: () => theirs,
          setRoomAccountData: write.theirs.mockReturnValue(Promise.resolve({})),
          on: () => {},
        },
      };
      const { svc, matrix } = provideRooms(clients['@me:hs']);
      ngMocks.stubMember(
        matrix,
        'accountIds',
        signal(['@me:hs', '@other:hs']).asReadonly(),
      );
      ngMocks.stubMember(
        matrix,
        'clientFor',
        ((id: string) => clients[id]) as never,
      );
      svc.connect();

      svc.clearMarkedUnread('!r:hs');

      expect(write.theirs).toHaveBeenCalledWith('!r:hs', 'm.marked_unread', {
        unread: false,
      });
      expect(write.mine).not.toHaveBeenCalled(); // it was never flagged there
    });

    it('does not erase a room’s real unread count while a write is in flight', async () => {
      // Un-flagging a room that genuinely has unread messages must leave it unread —
      // the overlay speaks only for the flag, not for the notification count.
      const { svc } = setupWritable([
        fakeRoom({
          roomId: '!r:hs',
          name: 'R',
          unread: 3,
          markedUnread: { unread: true },
        }),
      ]);

      await firstValueFrom(svc.setMarkedUnread('!r:hs', false));

      expect(svc.rooms()[0]).toMatchObject({
        markedUnread: false,
        unreadCount: 3,
        hasUnread: true,
      });
    });

    it('keeps two rooms’ pending writes apart', async () => {
      const { svc } = setupWritable([
        fakeRoom({ roomId: '!a:hs', name: 'A' }),
        fakeRoom({ roomId: '!b:hs', name: 'B' }),
      ]);

      await firstValueFrom(svc.setMarkedUnread('!a:hs', true));
      await firstValueFrom(svc.setMarkedUnread('!b:hs', true));

      const byId = new Map(svc.rooms().map((r) => [r.id, r] as const));
      expect(byId.get('!a:hs')?.markedUnread).toBe(true);
      expect(byId.get('!b:hs')?.markedUnread).toBe(true);
    });

    it('refuses to flag when the owning account has no client', async () => {
      // Reporting success for a write that never happened would leave the sidebar
      // showing a flag the account does not hold.
      const client = {
        baseUrl: 'https://hs.example',
        getRooms: () => [],
        on: () => {},
      };
      const { svc, matrix } = provideRooms(client);
      ngMocks.stubMember(matrix, 'clientFor', (() => null) as never);
      svc.connect();

      await expect(
        firstValueFrom(svc.setMarkedUnread('!r:hs', true, '@nobody:hs')),
      ).rejects.toThrow('Not signed in.');
    });

    it('clears by writing false rather than redacting', () => {
      const { svc, setRoomAccountData } = setupWritable([
        fakeRoom({
          roomId: '!r:hs',
          name: 'R',
          markedUnread: { unread: true },
        }),
      ]);

      svc.clearMarkedUnread('!r:hs');

      expect(setRoomAccountData).toHaveBeenCalledWith(
        '!r:hs',
        'm.marked_unread',
        {
          unread: false,
        },
      );
    });

    it('spends no write clearing a room that is not flagged', () => {
      // clearMarkedUnread runs on every room open, so an unconditional write would put
      // an account-data round trip behind every click in the room list.
      const { svc, setRoomAccountData } = setupWritable([
        fakeRoom({ roomId: '!r:hs', name: 'R' }),
      ]);

      svc.clearMarkedUnread('!r:hs');

      expect(setRoomAccountData).not.toHaveBeenCalled();
    });

    it('drops the flag when the room is marked read from its menu', async () => {
      // Otherwise the two controls contradict each other: the row would be acked and
      // still flagged, so it would keep reading as unread with no way out but opening it.
      const room = {
        ...fakeRoom({
          roomId: '!r:hs',
          name: 'R',
          markedUnread: { unread: true },
          // markRead walks back for the newest CONFIRMED event, so this one needs the
          // id and status fields the shared timelineEvent helper does not carry.
          events: [
            {
              ...timelineEvent({ body: 'hi' }),
              getId: () => '$e1',
              status: null,
            },
          ],
        }),
      };
      const setRoomAccountData = vi.fn(() => Promise.resolve({}));
      const client = {
        baseUrl: 'https://hs.example',
        getRooms: () => [room],
        getRoom: () => room,
        setRoomAccountData,
        setRoomReadMarkers: vi.fn(() => Promise.resolve({})),
        sendReadReceipt: vi.fn(() => Promise.resolve({})),
        on: () => {},
      };
      const { svc } = provideRooms(client);
      svc.connect();

      await firstValueFrom(svc.markRead('!r:hs'));

      expect(setRoomAccountData).toHaveBeenCalledWith(
        '!r:hs',
        'm.marked_unread',
        { unread: false },
      );
    });

    it('rebuilds when the flag changes on another device', async () => {
      // Room account data is what carries the flag between devices, and nothing in the
      // app listened to it before this — so a room flagged elsewhere would not have
      // surfaced until some unrelated event happened to rebuild the list.
      const room = fakeRoom({ roomId: '!r:hs', name: 'R' });
      const handlers = new Map<string, () => void>();
      const client = {
        baseUrl: 'https://hs.example',
        getRooms: () => [room],
        on: (event: string, handler: () => void) => {
          handlers.set(event, handler);
        },
      };
      const { svc } = provideRooms(client);
      svc.connect();
      expect(svc.rooms()[0].markedUnread).toBe(false);

      room.getAccountData = (type: string) =>
        type === 'm.marked_unread'
          ? { getContent: () => ({ unread: true }) }
          : undefined;
      handlers.get(RoomEvent.AccountData)?.();
      await Promise.resolve(); // the rebuild is coalesced into a microtask

      expect(svc.rooms()[0].markedUnread).toBe(true);
    });

    it('treats {unread: false} as cleared, which is how it is cleared', () => {
      // Other clients clear the flag by writing false rather than redacting the event,
      // so the presence of the event cannot be what counts.
      const svc = setup([
        fakeRoom({
          roomId: '!r:hs',
          name: 'R',
          markedUnread: { unread: false },
        }),
      ]);

      expect(svc.rooms()[0]).toMatchObject({
        markedUnread: false,
        hasUnread: false,
      });
    });
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
        getState: () => undefined,
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
    expect(sendReadReceipt).toHaveBeenCalledWith(latest, ReceiptType.Read);
  });

  it('acks privately when read receipts are turned off', async () => {
    const latest = { getId: () => '$latest', status: null };
    const room = {
      getLiveTimeline: () => ({
        getEvents: () => [latest],
        getState: () => undefined,
      }),
    };
    const sendReadReceipt = vi.fn().mockResolvedValue({});
    const client = {
      baseUrl: 'https://hs',
      getRooms: () => [],
      getRoom: () => room,
      sendReadReceipt,
      setRoomReadMarkers: vi.fn().mockResolvedValue({}),
      on: () => {},
    };
    const { svc } = provideRooms(client, false); // sendReadReceipts off

    await firstValueFrom(svc.markRead('!r:hs'));

    // Private receipt clears the badge without disclosing the read to others.
    expect(sendReadReceipt).toHaveBeenCalledWith(
      latest,
      ReceiptType.ReadPrivate,
    );
  });

  it('skips a pending local-echo tail and acks the newest confirmed event', async () => {
    const confirmed = { getId: () => '$confirmed', status: null };
    const room = {
      getLiveTimeline: () => ({
        getEvents: () => [
          confirmed,
          { getId: () => '$echo', status: 'sending' },
        ],
        getState: () => undefined,
      }),
    };
    const sendReadReceipt = vi.fn().mockResolvedValue({});
    const client = {
      baseUrl: 'https://hs',
      getRooms: () => [],
      getRoom: () => room,
      sendReadReceipt,
      setRoomReadMarkers: vi.fn().mockResolvedValue({}),
      on: () => {},
    };
    const { svc } = provideRooms(client);

    await firstValueFrom(svc.markRead('!r:hs'));

    expect(sendReadReceipt).toHaveBeenCalledWith(confirmed, ReceiptType.Read);
  });

  it('is a no-op for an unknown or empty room', async () => {
    const sendReadReceipt = vi.fn().mockResolvedValue({});
    const client = {
      baseUrl: 'https://hs',
      getRooms: () => [],
      getRoom: () => undefined, // unknown room
      sendReadReceipt,
      setRoomReadMarkers: vi.fn().mockResolvedValue({}),
      on: () => {},
    };
    const { svc } = provideRooms(client);

    await firstValueFrom(svc.markRead('!missing:hs'));

    expect(sendReadReceipt).not.toHaveBeenCalled();
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
    ngMocks.stubMember(matrix, 'instance', asClient(clientB));
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
    ngMocks.stubMember(matrix, 'instance', asClient(clientB));
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

  it('demoting a room writes the m.lowpriority tag and refreshes on resolve', async () => {
    const { svc, setRoomTag, deleteRoomTag, setRooms } = setup(false);
    setRooms([
      fakeRoom({ roomId: '!a:hs', name: 'general', lowPriority: true }),
    ]);

    svc.setLowPriority('!a:hs', true);
    await Promise.resolve();
    await Promise.resolve();

    expect(setRoomTag).toHaveBeenCalledWith('!a:hs', 'm.lowpriority', {});
    expect(deleteRoomTag).not.toHaveBeenCalled();
    expect(svc.rooms()[0].lowPriority).toBe(true);
  });

  it('restoring a room deletes the m.lowpriority tag and refreshes on resolve', async () => {
    const { svc, setRoomTag, deleteRoomTag, setRooms, handlers } = setup(false);

    // Get the projection to actually HOLD `true` first. Seeding the post-restore state and
    // then asserting `false` — which is what this test used to do — cannot fail: false is
    // also the value before the call, so it passed whether or not `refresh()` ever ran.
    setRooms([
      fakeRoom({ roomId: '!a:hs', name: 'general', lowPriority: true }),
    ]);
    handlers.get(RoomEvent.Tags)?.();
    await Promise.resolve();
    expect(svc.rooms()[0].lowPriority).toBe(true);

    // Now the tag is gone server-side, and only the post-write refresh can pick that up.
    setRooms([
      fakeRoom({ roomId: '!a:hs', name: 'general', lowPriority: false }),
    ]);
    svc.setLowPriority('!a:hs', false);
    await Promise.resolve();
    await Promise.resolve();

    expect(deleteRoomTag).toHaveBeenCalledWith('!a:hs', 'm.lowpriority');
    expect(setRoomTag).not.toHaveBeenCalled();
    expect(svc.rooms()[0].lowPriority).toBe(false);
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

  it('flags the room creator, and only them', () => {
    // The one thing a power level cannot express: every admin the creator promoted also
    // sits at 100, so "whose room is this?" is unanswerable without this.
    const svc = setup(
      fakeRoom({
        roomId: '!a:hs',
        name: 'general',
        creator: '@founder:hs',
        members: [
          fakeMember({
            userId: '@founder:hs',
            name: 'Founder',
            powerLevel: 100,
          }),
          fakeMember({
            userId: '@promoted:hs',
            name: 'Promoted',
            powerLevel: 100,
          }),
        ],
      }),
    );

    const list = svc.membersOf('!a:hs');
    expect(list.filter((m) => m.isCreator).map((m) => m.userId)).toEqual([
      '@founder:hs',
    ]);
  });

  it('flags nobody when the room reports no creator', () => {
    // getCreator() is nullable, and a null must not make every member look like one.
    const svc = setup(
      fakeRoom({
        roomId: '!a:hs',
        name: 'general',
        creator: null,
        members: [
          fakeMember({ userId: '@a:hs', name: 'Ada', powerLevel: 100 }),
        ],
      }),
    );

    expect(svc.membersOf('!a:hs').every((m) => !m.isCreator)).toBe(true);
  });

  it('still flags a creator who has since been demoted', () => {
    // m.room.create is immutable, so the fact survives any power change. Whether a
    // demoted creator should be PRESENTED as an owner is a separate, presentational
    // decision — the data layer reports what is true.
    const svc = setup(
      fakeRoom({
        roomId: '!a:hs',
        name: 'general',
        creator: '@founder:hs',
        members: [
          fakeMember({ userId: '@founder:hs', name: 'Founder', powerLevel: 0 }),
        ],
      }),
    );

    expect(svc.membersOf('!a:hs')[0].isCreator).toBe(true);
  });

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

// In the mixed-account view a sidebar row can belong to a signed-in account that ISN'T
// active. Every mutating action therefore takes an optional owning-account id and must act
// on THAT account's client — running them on the active one silently no-ops at best and, for
// leave(), makes the wrong account leave a room.
describe('RoomsService per-account actions', () => {
  function setup() {
    const activeClient = {
      getRoom: vi.fn(() => null),
      leave: vi.fn().mockResolvedValue({}),
      setRoomTag: vi.fn().mockResolvedValue({}),
      deleteRoomTag: vi.fn().mockResolvedValue({}),
      getRooms: () => [],
      on: vi.fn(),
      off: vi.fn(),
    };
    // markRead walks the live timeline for the newest confirmed event, so the owning
    // account's room needs one.
    const latest = { getId: () => '$latest', status: null };
    const ownerRoom = {
      ...fakeRoom({ roomId: '!r:hs', name: 'general' }),
      getLiveTimeline: () => ({
        getEvents: () => [latest],
        getState: () => undefined,
      }),
    };
    const ownerClient = {
      getRoom: vi.fn(() => ownerRoom),
      leave: vi.fn().mockResolvedValue({}),
      setRoomTag: vi.fn().mockResolvedValue({}),
      deleteRoomTag: vi.fn().mockResolvedValue({}),
      sendReadReceipt: vi.fn().mockResolvedValue({}),
      setRoomReadMarkers: vi.fn().mockResolvedValue({}),
      getRooms: () => [ownerRoom],
      on: vi.fn(),
      off: vi.fn(),
    };
    const { svc, matrix } = provideRooms(activeClient);
    ngMocks.stubMember(
      matrix,
      'clientFor',
      vi.fn((id: string) =>
        id === '@owner:hs' ? asClient(ownerClient) : null,
      ),
    );
    return { svc, activeClient, ownerClient };
  }

  it('leaves on the owning account, not the active one', async () => {
    const { svc, activeClient, ownerClient } = setup();

    await firstValueFrom(svc.leave('!r:hs', '@owner:hs'));

    expect(ownerClient.leave).toHaveBeenCalledWith('!r:hs');
    expect(activeClient.leave).not.toHaveBeenCalled();
  });

  it('still leaves on the active account when no owner is given', async () => {
    const { svc, activeClient, ownerClient } = setup();

    await firstValueFrom(svc.leave('!r:hs'));

    expect(activeClient.leave).toHaveBeenCalledWith('!r:hs');
    expect(ownerClient.leave).not.toHaveBeenCalled();
  });

  it('favourites on the owning account', async () => {
    const { svc, activeClient, ownerClient } = setup();

    svc.setFavourite('!r:hs', true, '@owner:hs');
    await Promise.resolve();

    expect(ownerClient.setRoomTag).toHaveBeenCalledWith(
      '!r:hs',
      'm.favourite',
      {},
    );
    expect(activeClient.setRoomTag).not.toHaveBeenCalled();
  });

  it('acks the read receipt on the owning account', async () => {
    const { svc, activeClient, ownerClient } = setup();

    await firstValueFrom(svc.markRead('!r:hs', '@owner:hs'));

    expect(ownerClient.setRoomReadMarkers).toHaveBeenCalledWith(
      '!r:hs',
      '$latest',
    );
    expect(ownerClient.sendReadReceipt).toHaveBeenCalled();
    expect(activeClient.getRoom).not.toHaveBeenCalled();
  });

  // clientFor() is null for an account that has signed out or hasn't started yet. A
  // destructive action must fail loudly rather than fall through to the active client.
  it('errors rather than falling back when the owning account has no client', async () => {
    const { svc, activeClient } = setup();

    await expect(
      firstValueFrom(svc.leave('!r:hs', '@gone:hs')),
    ).rejects.toThrow('Not signed in.');
    await expect(
      firstValueFrom(svc.markRead('!r:hs', '@gone:hs')),
    ).rejects.toThrow('Not signed in.');
    expect(activeClient.leave).not.toHaveBeenCalled();
  });

  it('quietly does nothing when favouriting on an account with no client', () => {
    const { svc, activeClient } = setup();

    expect(() => svc.setFavourite('!r:hs', true, '@gone:hs')).not.toThrow();
    expect(activeClient.setRoomTag).not.toHaveBeenCalled();
  });
});

// membersFor is the live half of membersOf: one signal per watched room, written only
// when a member event names that room.
describe('RoomsService membersFor', () => {
  function setup(rooms: ReturnType<typeof fakeRoom>[]) {
    const byId = new Map(rooms.map((r) => [r.roomId, r]));
    const client = {
      getRooms: () => rooms,
      getRoom: (id: string) => byId.get(id) ?? null,
      on: vi.fn(),
      off: vi.fn(),
    };
    const { svc } = provideRooms(client);
    svc.connect();
    return { svc, client };
  }

  /** Fire RoomState.members as the SDK does, naming the room it happened in. */
  function fireMemberChange(
    client: { on: Mock },
    roomId: string,
    userId = '@someone:hs',
    membership = 'join',
  ): void {
    const handler = client.on.mock.calls.find(
      ([e]) => e === 'RoomState.members',
    )?.[1] as ((e: unknown, s: unknown, m: unknown) => void) | undefined;
    handler?.({}, { roomId }, { userId, membership });
  }

  it('shares one signal per room', () => {
    const { svc } = setup([fakeRoom({ roomId: '!a:hs', name: 'general' })]);

    expect(svc.membersFor('!a:hs')).toBe(svc.membersFor('!a:hs'));
  });

  it('seeds synchronously, before any member event', () => {
    const { svc } = setup([
      fakeRoom({
        roomId: '!a:hs',
        name: 'general',
        members: [fakeMember({ userId: '@ada:hs', name: 'Ada' })],
      }),
    ]);

    expect(
      svc
        .membersFor('!a:hs')()
        .map((m) => m.userId),
    ).toEqual(['@ada:hs']);
  });

  it('removes a moderated member immediately while the SDK waits for sync', () => {
    const room = fakeRoom({
      roomId: '!a:hs',
      name: 'general',
      members: [
        fakeMember({ userId: '@ada:hs', name: 'Ada' }),
        fakeMember({ userId: '@bo:hs', name: 'Bo' }),
      ],
    });
    const { svc } = setup([room]);
    const members = svc.membersFor('!a:hs');

    svc.removeMemberFromProjection('!a:hs', '@bo:hs');

    expect(members().map((member) => member.userId)).toEqual(['@ada:hs']);
    // The projection must not mutate matrix-js-sdk's source of truth.
    expect(room.getJoinedMembers().map((member) => member.userId)).toEqual([
      '@ada:hs',
      '@bo:hs',
    ]);
  });

  it('does not resurrect a moderated member on an unrelated member event', async () => {
    const room = fakeRoom({
      roomId: '!a:hs',
      name: 'general',
      members: [
        fakeMember({ userId: '@ada:hs', name: 'Ada' }),
        fakeMember({ userId: '@bo:hs', name: 'Bo' }),
      ],
    });
    const { svc, client } = setup([room]);
    const members = svc.membersFor('!a:hs');

    svc.removeMemberFromProjection('!a:hs', '@bo:hs');
    fireMemberChange(client, '!a:hs', '@ada:hs');
    await Promise.resolve();

    expect(members().map((member) => member.userId)).toEqual(['@ada:hs']);
  });

  it('hands the roster back to sync after the moderated membership arrives', async () => {
    const roster = [
      fakeMember({ userId: '@ada:hs', name: 'Ada' }),
      fakeMember({ userId: '@bo:hs', name: 'Bo' }),
    ];
    const room = fakeRoom({
      roomId: '!a:hs',
      name: 'general',
      members: roster,
    });
    const { svc, client } = setup([room]);
    const members = svc.membersFor('!a:hs');

    svc.removeMemberFromProjection('!a:hs', '@bo:hs');
    roster.splice(1, 1);
    fireMemberChange(client, '!a:hs', '@bo:hs', 'leave');
    await Promise.resolve();
    expect(members().map((member) => member.userId)).toEqual(['@ada:hs']);

    roster.push(fakeMember({ userId: '@bo:hs', name: 'Bo' }));
    fireMemberChange(client, '!a:hs', '@bo:hs');
    await Promise.resolve();
    expect(members().map((member) => member.userId)).toEqual([
      '@ada:hs',
      '@bo:hs',
    ]);
  });

  it('does not tombstone a rejoin when sync beats the moderation response', async () => {
    const roster = [
      fakeMember({ userId: '@ada:hs', name: 'Ada' }),
      fakeMember({ userId: '@bo:hs', name: 'Bo' }),
    ];
    const room = fakeRoom({
      roomId: '!a:hs',
      name: 'general',
      members: roster,
    });
    const { svc, client } = setup([room]);
    const members = svc.membersFor('!a:hs');

    roster.splice(1, 1);
    fireMemberChange(client, '!a:hs', '@bo:hs', 'leave');
    await Promise.resolve();

    // The successful HTTP response arrives after its authoritative sync echo.
    svc.removeMemberFromProjection('!a:hs', '@bo:hs');
    roster.push(fakeMember({ userId: '@bo:hs', name: 'Bo' }));
    fireMemberChange(client, '!a:hs', '@bo:hs');
    await Promise.resolve();

    expect(members().map((member) => member.userId)).toEqual([
      '@ada:hs',
      '@bo:hs',
    ]);
  });

  it('re-reads the room a member event names', async () => {
    // Held here and mutated: fakeRoom reads `members` live on every getJoinedMembers().
    const roster = [fakeMember({ userId: '@ada:hs', name: 'Ada' })];
    const room = fakeRoom({
      roomId: '!a:hs',
      name: 'general',
      members: roster,
    });
    const { svc, client } = setup([room]);
    const members = svc.membersFor('!a:hs');

    roster.push(fakeMember({ userId: '@bo:hs', name: 'Bo' }));
    fireMemberChange(client, '!a:hs');
    // The re-read is batched onto a microtask: RoomState.members fans out per member, so
    // one bulk change emits N times and each read is O(members).
    await Promise.resolve();

    expect(members().map((m) => m.userId)).toEqual(['@ada:hs', '@bo:hs']);
  });

  it('leaves other rooms alone when a member changes elsewhere', async () => {
    // The point of dispatching on `state.roomId`. The counter this replaced was
    // unfiltered, so a busy room woke every member list in the app.
    const quietRoster = [fakeMember({ userId: '@ada:hs', name: 'Ada' })];
    const quiet = fakeRoom({
      roomId: '!quiet:hs',
      name: 'quiet',
      members: quietRoster,
    });
    const busy = fakeRoom({ roomId: '!busy:hs', name: 'busy' });
    const { svc, client } = setup([quiet, busy]);
    const quietMembers = svc.membersFor('!quiet:hs');
    const before = quietMembers();

    // Mutating the quiet room too, so a re-read would be VISIBLE rather than merely
    // equal — otherwise the memo would make this pass either way.
    quietRoster.push(fakeMember({ userId: '@late:hs', name: 'Late' }));
    fireMemberChange(client, '!busy:hs');
    // Flushed BEFORE asserting, or "did not re-read" passes against an unflushed turn.
    await Promise.resolve();

    expect(quietMembers()).toBe(before);
  });

  it('holds the same array when the room re-reads unchanged', async () => {
    const { svc, client } = setup([
      fakeRoom({
        roomId: '!a:hs',
        name: 'general',
        members: [fakeMember({ userId: '@ada:hs', name: 'Ada' })],
      }),
    ]);
    const members = svc.membersFor('!a:hs');
    const before = members();

    fireMemberChange(client, '!a:hs');
    await Promise.resolve();

    // membersOf's fingerprint memo returns the identical array, so Object.is stops the
    // write propagating. This is what makes writing on every member event cheap.
    expect(members()).toBe(before);
  });

  it('re-reads every watched room when our own membership changes', async () => {
    // MyMembership names no room, so there is nothing to dispatch on.
    const roster: ReturnType<typeof fakeMember>[] = [];
    const room = fakeRoom({
      roomId: '!a:hs',
      name: 'general',
      members: roster,
    });
    const { svc, client } = setup([room]);
    const members = svc.membersFor('!a:hs');

    roster.push(fakeMember({ userId: '@ada:hs', name: 'Ada' }));
    // Registered TWICE: once in the projection's coalesced event list (which rebuilds the
    // room list) and once by `bind` (which re-reads members). The second is the one under
    // test, so take the last rather than the first.
    const handlers = client.on.mock.calls
      .filter(([e]) => e === 'Room.myMembership')
      .map((call) => call[1] as () => void);
    expect(handlers.length).toBe(2);
    handlers[handlers.length - 1]();
    await Promise.resolve();

    expect(members().map((m) => m.userId)).toEqual(['@ada:hs']);
  });

  it('re-reads against the new client when the projection rewires', () => {
    // The signals hold VALUES, so a re-login or account switch has to re-read them —
    // nothing else does. Their writers are bound to the active client only, so without
    // this a member list survives a switch showing the previous account's members, and a
    // MyMembership from the new client wipes it to [] instead.
    const roster = [fakeMember({ userId: '@ada:hs', name: 'Ada' })];
    const room = fakeRoom({
      roomId: '!a:hs',
      name: 'general',
      members: roster,
    });
    const first = {
      getRooms: () => [room],
      getRoom: (id: string) => (id === '!a:hs' ? room : null),
      on: vi.fn(),
      off: vi.fn(),
    };
    const { svc, matrix } = provideRooms(first);
    svc.connect();
    const members = svc.membersFor('!a:hs');
    expect(members().map((m) => m.userId)).toEqual(['@ada:hs']);

    // A different client, whose copy of the room has a different membership.
    const rosterB = [fakeMember({ userId: '@bo:hs', name: 'Bo' })];
    const roomB = fakeRoom({
      roomId: '!a:hs',
      name: 'general',
      members: rosterB,
    });
    const second = {
      getRooms: () => [roomB],
      getRoom: (id: string) => (id === '!a:hs' ? roomB : null),
      on: vi.fn(),
      off: vi.fn(),
    };
    ngMocks.stubMember(matrix, 'instance', second as never);
    svc.connect();

    expect(members().map((m) => m.userId)).toEqual(['@bo:hs']);
  });

  it('is empty, not thrown, for a null room id', () => {
    const { svc } = setup([fakeRoom({ roomId: '!a:hs', name: 'general' })]);

    expect(svc.membersFor(null)()).toEqual([]);
  });

  it('clears the member signals on disconnect, keeping the empty identity', () => {
    const roster = [fakeMember({ userId: '@ada:hs', name: 'Ada' })];
    const room = fakeRoom({
      roomId: '!a:hs',
      name: 'general',
      members: roster,
    });
    const { svc } = setup([room]);
    const members = svc.membersFor('!a:hs');
    const none = svc.membersFor(null);
    const emptyBefore = none();
    expect(members().map((m) => m.userId)).toEqual(['@ada:hs']);

    svc.disconnect();

    // Cleared, so a detached service holds none of the outgoing client's members...
    expect(members()).toEqual([]);
    // ...but through the SHARED empty list, or every disconnect re-notifies every consumer
    // of the null-room signal — the landing state.
    expect(none()).toBe(emptyBefore);
  });

  it('drops a member re-read queued before the disconnect', async () => {
    // `projectFromClient` cancels its own coalescer on disconnect and cannot know about
    // this one. Left queued, the flush runs after `reset` and repopulates the list from the
    // client being let go of — the stale list, arriving a microtask late.
    const roster = [fakeMember({ userId: '@ada:hs', name: 'Ada' })];
    const room = fakeRoom({
      roomId: '!a:hs',
      name: 'general',
      members: roster,
    });
    const { svc, client } = setup([room]);
    const members = svc.membersFor('!a:hs');

    roster.push(fakeMember({ userId: '@bo:hs', name: 'Bo' }));
    fireMemberChange(client, '!a:hs');
    svc.disconnect();
    await Promise.resolve();

    expect(members()).toEqual([]);
  });

  it('does not re-read every watched room on an ordinary sync', async () => {
    // The re-read on rebuild is gated on the CLIENT having changed. Ungated, every sync
    // would re-read every watched room and undo the point of dispatching on state.roomId.
    const roster = [fakeMember({ userId: '@ada:hs', name: 'Ada' })];
    const room = fakeRoom({
      roomId: '!a:hs',
      name: 'general',
      members: roster,
    });
    const { svc, client } = setup([room]);
    const members = svc.membersFor('!a:hs');
    const before = members();
    // Pushed so a re-read would be VISIBLE rather than merely equal.
    roster.push(fakeMember({ userId: '@bo:hs', name: 'Bo' }));

    const onSync = client.on.mock.calls.find(([e]) => e === 'sync')?.[1] as
      (() => void) | undefined;
    onSync?.();
    await Promise.resolve();

    expect(members()).toBe(before);
  });

  it('forgets a room once its flush has run', async () => {
    // The dirty set has to be emptied by the flush, or every later flush re-reads every
    // room ever dirtied — unbounded per-turn cost that grows with the session.
    const rosterA = [fakeMember({ userId: '@ada:hs', name: 'Ada' })];
    const roomA = fakeRoom({ roomId: '!a:hs', name: 'a', members: rosterA });
    const roomB = fakeRoom({ roomId: '!b:hs', name: 'b' });
    const { svc, client } = setup([roomA, roomB]);
    svc.membersFor('!a:hs');
    svc.membersFor('!b:hs');

    fireMemberChange(client, '!a:hs');
    await Promise.resolve();

    // Counted only from here, so this measures the SECOND flush.
    let readsA = 0;
    const originalA = roomA.getJoinedMembers;
    roomA.getJoinedMembers = () => {
      readsA += 1;
      return originalA();
    };
    fireMemberChange(client, '!b:hs');
    await Promise.resolve();

    expect(readsA).toBe(0);
  });

  it('holds the same empty list for a room it cannot read', async () => {
    // The identity invariant has to hold on the EMPTY paths too, or the null-room signal —
    // the landing state, and the state after every closeOpenRoom() — re-notifies its
    // consumers on every write. `membersOf` returns a shared frozen list for these.
    const { svc, client } = setup([
      fakeRoom({ roomId: '!a:hs', name: 'general' }),
    ]);
    const none = svc.membersFor(null);
    const before = none();

    const handlers = client.on.mock.calls
      .filter(([e]) => e === 'Room.myMembership')
      .map((call) => call[1] as () => void);
    handlers[handlers.length - 1]();
    await Promise.resolve();

    expect(none()).toBe(before);
  });

  it('collapses a per-member fan-out into one re-read', async () => {
    // RoomState.members is emitted once PER MEMBER inside a loop, and each read is
    // O(members) — the fingerprint runs before the memo can hit — so un-batched a bulk
    // membership set is quadratic on the main thread.
    const roster = [fakeMember({ userId: '@ada:hs', name: 'Ada' })];
    const room = fakeRoom({
      roomId: '!a:hs',
      name: 'general',
      members: roster,
    });
    const { svc, client } = setup([room]);
    svc.membersFor('!a:hs');
    let reads = 0;
    const original = room.getJoinedMembers;
    room.getJoinedMembers = () => {
      reads += 1;
      return original();
    };

    fireMemberChange(client, '!a:hs');
    fireMemberChange(client, '!a:hs');
    fireMemberChange(client, '!a:hs');
    await Promise.resolve();

    expect(reads).toBe(1);
  });

  describe('typing, per room', () => {
    /** A room whose members report a typing state, plus the client that owns it. */
    function setupTyping() {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const members: Record<
        string,
        { userId: string; name: string; typing: boolean }[]
      > = {
        '!a:hs': [
          { userId: '@alice:hs', name: 'Alice', typing: false },
          { userId: '@me:hs', name: 'Me', typing: false },
        ],
        '!b:hs': [{ userId: '@bob:hs', name: 'Bob', typing: false }],
      };
      const rooms = [
        fakeRoom({ roomId: '!a:hs', name: 'A' }),
        fakeRoom({ roomId: '!b:hs', name: 'B' }),
      ];
      const client = {
        baseUrl: 'https://hs.example',
        getRooms: () => rooms,
        getUserId: () => '@me:hs',
        getRoom: (roomId: string) =>
          members[roomId]
            ? {
                getMembers: () => members[roomId],
                getMember: (userId: string) =>
                  members[roomId].find((m) => m.userId === userId) ?? null,
              }
            : null,
        on: (event: string, handler: (...args: unknown[]) => void) => {
          handlers.set(event, handler);
        },
        off: (event: string) => {
          handlers.delete(event);
        },
      };
      const { svc, matrix } = provideRooms(client);
      // Self-exclusion spans EVERY signed-in account, not just the active one, so the stub
      // has to name them — a bare provideRooms leaves accountIds empty and the local user
      // announces themselves.
      ngMocks.stubMember(matrix, 'accountIds', signal(['@me:hs']).asReadonly());
      svc.connect();

      /**
       * Flip a member's typing flag and fire the event the SDK would.
       *
       * The event carries `user_ids` — the room's WHOLE typing set — because that is what
       * `m.typing` is and what the service reads. A fake that omitted it would make the
       * service look broken while the real one worked, and vice versa.
       */
      const fire = (roomId: string, userId: string, typing: boolean) => {
        const member = members[roomId].find((m) => m.userId === userId);
        if (member) {
          member.typing = typing;
        }
        const user_ids = members[roomId]
          .filter((m) => m.typing)
          .map((m) => m.userId);
        handlers.get(RoomMemberEvent.Typing)?.(
          { getContent: () => ({ user_ids }) },
          { roomId, userId },
        );
      };

      return { svc, matrix, handlers, fire, members };
    }

    it('projects a room typing set, excluding the local user', async () => {
      const { svc, fire } = setupTyping();

      fire('!a:hs', '@alice:hs', true);
      await Promise.resolve();
      expect(svc.typingByRoom()['!a:hs']).toEqual(['Alice']);

      // Self must never appear: "You are typing" on your own room is the failure.
      fire('!a:hs', '@me:hs', true);
      await Promise.resolve();
      expect(svc.typingByRoom()['!a:hs']).toEqual(['Alice']);
    });

    it('excludes every signed-in account, not just the active one', async () => {
      // A room both accounts are joined to renders as ONE row, so filtering only the active
      // mxid let the user's own other account announce itself on their own room.
      const { svc, matrix, fire, members } = setupTyping();
      ngMocks.stubMember(
        matrix,
        'accountIds',
        signal(['@me:hs', '@other:hs']).asReadonly(),
      );
      members['!a:hs'].push({
        userId: '@other:hs',
        name: 'Other Me',
        typing: false,
      });

      fire('!a:hs', '@other:hs', true);
      await Promise.resolve();
      expect(svc.typingByRoom()['!a:hs']).toBeUndefined();

      // …and a genuine stranger still comes through, so the filter is not just off.
      fire('!a:hs', '@alice:hs', true);
      await Promise.resolve();
      expect(svc.typingByRoom()['!a:hs']).toEqual(['Alice']);
    });

    it('drops a room typing set when we leave the room', async () => {
      // A left room stops syncing, so its members never emit the "stopped" transition. The
      // key would survive the session and reappear on rejoin — frozen, because an unchanged
      // set writes nothing.
      const { svc, handlers, fire } = setupTyping();
      fire('!a:hs', '@alice:hs', true);
      await Promise.resolve();
      expect(svc.typingByRoom()['!a:hs']).toEqual(['Alice']);

      handlers.get(RoomEvent.MyMembership)?.({ roomId: '!a:hs' }, 'leave');
      await Promise.resolve();

      expect(svc.typingByRoom()['!a:hs']).toBeUndefined();
    });

    it('keys each room separately and drops a room that goes quiet', async () => {
      const { svc, fire } = setupTyping();

      fire('!a:hs', '@alice:hs', true);
      fire('!b:hs', '@bob:hs', true);
      await Promise.resolve();
      expect(svc.typingByRoom()).toEqual({
        '!a:hs': ['Alice'],
        '!b:hs': ['Bob'],
      });

      fire('!a:hs', '@alice:hs', false);
      await Promise.resolve();
      expect(svc.typingByRoom()).toEqual({ '!b:hs': ['Bob'] });
    });

    it('writes nothing when a room typing set is unchanged', async () => {
      const { svc, fire } = setupTyping();

      // Positive control FIRST: without it the identity check below passes when the
      // listener was never registered at all, comparing undefined to undefined.
      fire('!a:hs', '@alice:hs', true);
      await Promise.resolve();
      const first = svc.typingByRoom();
      expect(first['!a:hs']).toEqual(['Alice']);

      // A repeat EDU with the same set. Coalesced, so the flush is what makes this a
      // real negative rather than a vacuous one.
      fire('!a:hs', '@alice:hs', true);
      await Promise.resolve();
      expect(svc.typingByRoom()).toBe(first);

      // …and it still CAN change, or the assertion above is satisfied by a dead writer.
      fire('!b:hs', '@bob:hs', true);
      await Promise.resolve();
      expect(svc.typingByRoom()).not.toBe(first);
    });

    it('detaches the listener and clears the map on disconnect', async () => {
      const { svc, handlers, fire } = setupTyping();

      fire('!a:hs', '@alice:hs', true);
      await Promise.resolve();
      expect(svc.typingByRoom()['!a:hs']).toEqual(['Alice']);

      svc.disconnect();
      await Promise.resolve();

      // Both halves matter. A stale line naming the OUTGOING account's typists is the
      // bug the surrounding `reset` comments exist to prevent.
      expect(handlers.has(RoomMemberEvent.Typing)).toBe(false);
      expect(svc.typingByRoom()).toEqual({});
    });
  });
});
