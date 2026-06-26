import { TestBed } from '@angular/core/testing';
import { RoomsService } from './rooms.service';
import { MatrixClientService } from './matrix-client.service';
import { describe, expect, it } from 'vitest';

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
}) {
  return {
    roomId: opts.roomId,
    name: opts.name,
    isSpaceRoom: () => opts.space ?? false,
    getMyMembership: () => opts.membership ?? 'join',
    getAvatarUrl: () => null,
    getJoinedMemberCount: () => 0,
    getJoinedMembers: () => [],
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

  it('splits spaces from joined rooms', () => {
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

    expect(svc.spaces().map((s) => s.id)).toEqual(['!s:hs']);
    expect(svc.rooms().map((r) => r.id)).toEqual(['!a:hs']); // 'left' filtered out
  });

  it('filters rooms by space membership, falling back to all for Home', () => {
    const svc = setup([
      fakeRoom({
        roomId: '!s:hs',
        name: 'Space',
        space: true,
        children: ['!a:hs'],
      }),
      fakeRoom({ roomId: '!a:hs', name: 'in-space' }),
      fakeRoom({ roomId: '!b:hs', name: 'orphan' }),
    ]);

    expect(svc.roomsForSpace(null).map((r) => r.id)).toEqual([
      '!a:hs',
      '!b:hs',
    ]);
    expect(svc.roomsForSpace('!s:hs').map((r) => r.id)).toEqual(['!a:hs']);
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
});
