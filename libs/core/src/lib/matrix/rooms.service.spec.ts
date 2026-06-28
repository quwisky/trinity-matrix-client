import { TestBed } from '@angular/core/testing';
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
