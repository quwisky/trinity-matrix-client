import { TestBed } from '@angular/core/testing';
import { RoomsService } from './rooms.service';
import { MatrixClientService } from './matrix-client.service';

// Minimal fakes shaped like the bits of matrix-js-sdk that RoomsService reads.
function fakeRoom(opts: {
  roomId: string;
  name: string;
  space?: boolean;
  membership?: string;
  children?: string[];
}) {
  return {
    roomId: opts.roomId,
    name: opts.name,
    isSpaceRoom: () => opts.space ?? false,
    getMyMembership: () => opts.membership ?? 'join',
    getAvatarUrl: () => null,
    getJoinedMemberCount: () => 0,
    getJoinedMembers: () => [],
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

  it('derives an uppercase initial without the leading sigil', () => {
    const svc = setup([fakeRoom({ roomId: '!a:hs', name: '#general' })]);
    expect(svc.rooms()[0].initial).toBe('G');
  });
});
