import { TestBed } from '@angular/core/testing';
import { ApplicationRef, signal, type WritableSignal } from '@angular/core';
import {
  ClientEvent,
  MatrixEventEvent,
  ReceiptType,
  RoomEvent,
  RoomStateEvent,
} from 'matrix-js-sdk';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { RoomsService } from './rooms.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { PrivacySettingsService } from '@trinity/platform-native';
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
 * Provide RoomsService with a MockProvider-backed MatrixClientService whose
 * `instance` getter yields `client` and whose `isInitialized` is true, matching the
 * data-holder shape the service reads. Returns both so tests can re-point `instance`.
 */
function provideRooms(
  client: unknown,
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
      const clients: Record<string, unknown> = {
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
    const { svc, setRoomTag, deleteRoomTag, setRooms } = setup(false);
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
      vi.fn((id: string) => (id === '@owner:hs' ? ownerClient : null)),
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
