import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { RoomsService } from './rooms.service';
import { MatrixClientService } from './matrix-client.service';
import { describe, expect, it, vi } from 'vitest';

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
}) {
  return {
    roomId: opts.roomId,
    name: opts.name,
    isSpaceRoom: () => opts.space ?? false,
    getMyMembership: () => opts.membership ?? 'join',
    getMxcAvatarUrl: () => null,
    getJoinedMemberCount: () => 0,
    getJoinedMembers: () => [],
    hasEncryptionStateEvent: () => opts.encrypted ?? false,
    getUnreadNotificationCount: (type?: string) =>
      type === 'highlight' ? (opts.highlight ?? 0) : (opts.unread ?? 0),
    getLastActiveTimestamp: () => opts.activity ?? 0,
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

describe('RoomsService', () => {
  function setup(rooms: ReturnType<typeof fakeRoom>[]) {
    const client = {
      baseUrl: 'https://hs.example',
      getRooms: () => rooms,
      on: () => {},
    };
    const matrix = {
      isInitialized: true,
      instance: client,
    } as unknown as MatrixClientService;

    TestBed.configureTestingModule({
      providers: [
        RoomsService,
        { provide: MatrixClientService, useValue: matrix },
      ],
    });
    const svc = TestBed.inject(RoomsService);
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
  });

  it('derives an uppercase initial without the leading sigil', () => {
    const svc = setup([fakeRoom({ roomId: '!a:hs', name: '#general' })]);
    expect(svc.rooms()[0].initial).toBe('G');
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

  it('rewires onto a new client after re-login instead of freezing', () => {
    const makeClient = (rooms: ReturnType<typeof fakeRoom>[]) => ({
      baseUrl: 'https://hs.example',
      getRooms: () => rooms,
      on: vi.fn(),
      off: vi.fn(),
    });
    const clientA = makeClient([fakeRoom({ roomId: '!a:hs', name: 'A' })]);
    const clientB = makeClient([fakeRoom({ roomId: '!b:hs', name: 'B' })]);
    const matrix = {
      isInitialized: true,
      instance: clientA,
    } as unknown as MatrixClientService;

    TestBed.configureTestingModule({
      providers: [
        RoomsService,
        { provide: MatrixClientService, useValue: matrix },
      ],
    });
    const svc = TestBed.inject(RoomsService);

    svc.connect();
    expect(svc.rooms().map((r) => r.id)).toEqual(['!a:hs']);

    // Simulate logout→login: MatrixClientService swaps in a fresh client.
    (matrix as unknown as { instance: unknown }).instance = clientB;
    svc.connect();

    expect(svc.rooms().map((r) => r.id)).toEqual(['!b:hs']); // not frozen on A
    expect(clientA.off).toHaveBeenCalled(); // old listeners detached
    expect(clientB.on).toHaveBeenCalled(); // new client wired
  });

  it('ignores a repeat connect() for the same client', () => {
    const client = {
      baseUrl: 'https://hs.example',
      getRooms: () => [],
      on: vi.fn(),
      off: vi.fn(),
    };
    const matrix = {
      isInitialized: true,
      instance: client,
    } as unknown as MatrixClientService;
    TestBed.configureTestingModule({
      providers: [
        RoomsService,
        { provide: MatrixClientService, useValue: matrix },
      ],
    });
    const svc = TestBed.inject(RoomsService);

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
      on: vi.fn(),
      off: vi.fn(),
    };
    const matrix = {
      isInitialized: true,
      instance: client,
    } as unknown as MatrixClientService;

    TestBed.configureTestingModule({
      providers: [
        RoomsService,
        { provide: MatrixClientService, useValue: matrix },
      ],
    });
    const svc = TestBed.inject(RoomsService);
    return { svc, createRoom, invite, setAccountData, searchUserDirectory };
  }

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
    const matrix = {
      isInitialized: true,
      instance: client,
    } as unknown as MatrixClientService;
    TestBed.configureTestingModule({
      providers: [
        RoomsService,
        { provide: MatrixClientService, useValue: matrix },
      ],
    });
    const svc = TestBed.inject(RoomsService);
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
