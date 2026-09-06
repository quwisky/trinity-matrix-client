import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type MatrixClient } from 'matrix-js-sdk';
import { MockProvider, ngMocks } from 'ng-mocks';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomMembersService } from './room-members.service';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';

function member(
  userId: string,
  name: string,
  powerLevel = 0,
  avatarMxc?: string,
) {
  return {
    userId,
    name,
    powerLevel,
    membership: 'join',
    getMxcAvatarUrl: () => avatarMxc,
  };
}

function bannedMember(userId: string, name: string, reason?: string) {
  return {
    userId,
    name,
    events: {
      member: { getContent: () => ({ reason }) },
    },
  };
}

function room(
  roomId: string,
  members: ReturnType<typeof member>[],
  creator: string | null = null,
  banned: ReturnType<typeof bannedMember>[] = [],
) {
  return {
    roomId,
    getMyMembership: () => 'join',
    getJoinedMembers: vi.fn(() => members),
    getMembersWithMembership: vi.fn(() => banned),
    getCreator: () => creator,
  };
}

function client(rooms: ReturnType<typeof room>[]) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    getRoom: (roomId: string) =>
      rooms.find((candidate) => candidate.roomId === roomId) ?? null,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    off: vi.fn((event: string) => handlers.delete(event)),
    handlers,
  };
}

function setup(initialClient: ReturnType<typeof client>) {
  const activeUserId = signal<string | null>('@me:hs');
  TestBed.configureTestingModule({
    providers: [
      RoomMembersService,
      MockProvider(MatrixClientService, {
        activeUserId: activeUserId.asReadonly(),
      }),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  ngMocks.stubMember(matrix, 'isInitialized', true);
  ngMocks.stubMember(
    matrix,
    'instance',
    initialClient as unknown as MatrixClient,
  );
  const service = TestBed.inject(RoomMembersService);
  const projectionState = TestBed.inject(RoomAdministrationProjectionState);
  projectionState.select(activeUserId(), '!room:hs');
  projectionState.update('members', 'available', 'retained');
  projectionState.update('bans', 'available', 'retained');
  const lifetime = service.runProjection().subscribe();
  return { service, matrix, activeUserId, lifetime, projectionState };
}

function fireMemberChange(
  matrixClient: ReturnType<typeof client>,
  roomId: string,
): void {
  matrixClient.handlers.get('RoomState.members')?.({}, { roomId }, {});
}

describe('RoomMembersService', () => {
  it('observes an exact opening Account without following the active Account', async () => {
    const openingMembers = [member('@ada:hs', 'Ada')];
    const openingClient = client([room('!shared:hs', openingMembers)]);
    const otherClient = client([
      room('!shared:hs', [member('@mallory:hs', 'Mallory')]),
    ]);
    const accountIds = signal<readonly string[]>(['@opening:hs', '@other:hs']);
    TestBed.configureTestingModule({
      providers: [
        RoomMembersService,
        MockProvider(MatrixClientService, {
          accountIds: accountIds.asReadonly(),
          activeUserId: signal<string | null>('@other:hs').asReadonly(),
          clientFor: (accountId: string) =>
            accountId === '@opening:hs'
              ? (openingClient as unknown as MatrixClient)
              : (otherClient as unknown as MatrixClient),
        }),
      ],
    });
    const service = TestBed.inject(RoomMembersService);
    const seen: string[][] = [];
    const observation = service
      .observe({ accountId: '@opening:hs', roomId: '!shared:hs' })
      .subscribe((value) =>
        seen.push(value.members.map((candidate) => candidate.roomDisplayName)),
      );
    TestBed.inject(ApplicationRef).tick();

    expect(seen.at(-1)).toEqual(['Ada']);

    openingMembers.push(member('@bea:hs', 'Bea'));
    fireMemberChange(openingClient, '!shared:hs');

    expect(seen.at(-1)).toEqual(['Ada', 'Bea']);
    expect(seen.flat()).not.toContain('Mallory');
    observation.unsubscribe();
  });

  it('projects sorted authoritative summaries with creator, avatar, and power', () => {
    const source = room(
      '!room:hs',
      [
        member('@zoe:hs', 'Zoe', 50),
        member('@ada:hs', 'Ada', 100, 'mxc://hs/ada'),
      ],
      '@ada:hs',
    );
    const { service } = setup(client([source]));

    expect(service.membersOf('!room:hs')).toEqual([
      {
        userId: '@ada:hs',
        roomDisplayName: 'Ada',
        roomInitial: 'A',
        roomAvatarMxc: 'mxc://hs/ada',
        powerLevel: 100,
        isCreator: true,
      },
      {
        userId: '@zoe:hs',
        roomDisplayName: 'Zoe',
        roomInitial: 'Z',
        roomAvatarMxc: null,
        powerLevel: 50,
        isCreator: false,
      },
    ]);
  });

  it('shares a signal and updates only after an authoritative member event', async () => {
    const members = [member('@ada:hs', 'Ada')];
    const source = room('!room:hs', members);
    const matrixClient = client([source]);
    const { service } = setup(matrixClient);
    const roster = service.membersFor('!room:hs');

    expect(roster).toBe(service.membersFor('!room:hs'));
    members.push(member('@bob:hs', 'Bob'));
    expect(roster().map((item) => item.roomDisplayName)).toEqual(['Ada']);

    fireMemberChange(matrixClient, '!room:hs');
    await Promise.resolve();
    expect(roster().map((item) => item.roomDisplayName)).toEqual([
      'Ada',
      'Bob',
    ]);
  });

  it('coalesces the SDK per-member fan-out into one roster read', async () => {
    const source = room('!room:hs', [member('@ada:hs', 'Ada')]);
    const matrixClient = client([source]);
    const { service } = setup(matrixClient);
    service.membersFor('!room:hs');
    source.getJoinedMembers.mockClear();

    fireMemberChange(matrixClient, '!room:hs');
    fireMemberChange(matrixClient, '!room:hs');
    fireMemberChange(matrixClient, '!room:hs');
    await Promise.resolve();

    expect(source.getJoinedMembers).toHaveBeenCalledOnce();
  });

  it('reprojects power changes even when member identity is unchanged', async () => {
    const ada = member('@ada:hs', 'Ada');
    const source = room('!room:hs', [ada]);
    const matrixClient = client([source]);
    const { service } = setup(matrixClient);
    const roster = service.membersFor('!room:hs');

    ada.powerLevel = 100;
    fireMemberChange(matrixClient, '!room:hs');
    await Promise.resolve();

    expect(roster()[0].powerLevel).toBe(100);
  });

  it('authoritatively rereads retained member and ban signals on retry', async () => {
    const members = [member('@ada:hs', 'Ada')];
    const source = room('!room:hs', members);
    const { service } = setup(client([source]));
    const roster = service.membersFor('!room:hs');

    members.push(member('@bob:hs', 'Bob'));
    service.retryProjection();
    await Promise.resolve();

    expect(roster().map((item) => item.roomDisplayName)).toEqual([
      'Ada',
      'Bob',
    ]);
  });

  it('projects bans and waits for authoritative member events to update them', async () => {
    const banned = [
      bannedMember('@zed:hs', 'Zed', 'spam'),
      bannedMember('@amy:hs', 'Amy'),
    ];
    const source = room('!room:hs', [], null, banned);
    const matrixClient = client([source]);
    const { service } = setup(matrixClient);
    const bans = service.bannedFor('!room:hs');

    expect(bans()).toEqual([
      { userId: '@amy:hs', roomDisplayName: 'Amy', reason: null },
      { userId: '@zed:hs', roomDisplayName: 'Zed', reason: 'spam' },
    ]);

    banned.splice(0, banned.length);
    expect(bans()).toHaveLength(2);
    fireMemberChange(matrixClient, '!room:hs');
    await Promise.resolve();

    expect(bans()).toEqual([]);
  });

  it('clears outgoing Account values and detaches listeners on teardown', async () => {
    const matrixClient = client([room('!room:hs', [member('@ada:hs', 'Ada')])]);
    const { service, lifetime } = setup(matrixClient);
    const roster = service.membersFor('!room:hs');
    expect(roster()).toHaveLength(1);

    lifetime.unsubscribe();
    TestBed.inject(ApplicationRef).tick();
    await Promise.resolve();

    expect(roster()).toEqual([]);
    expect(matrixClient.off as Mock).toHaveBeenCalled();
  });

  it('separates coherent, stale, and unavailable membership presentation', () => {
    const source = room('!room:hs', [member('@ada:hs', 'Ada')]);
    const { service, projectionState } = setup(client([source]));

    expect(service.membersView('!room:hs')).toMatchObject({
      availability: 'coherent',
      current: [{ userId: '@ada:hs' }],
      stale: null,
    });

    projectionState.update('members', 'failed', 'retained');
    expect(service.membersView('!room:hs')).toMatchObject({
      availability: 'stale',
      current: null,
      stale: [{ userId: '@ada:hs' }],
    });

    projectionState.update('members', 'released', 'released');
    expect(service.membersView('!room:hs')).toEqual({
      availability: 'unavailable',
      current: null,
      stale: null,
    });
  });

  it('does not label an unavailable empty ban list as authoritative', () => {
    const { service, projectionState } = setup(client([room('!room:hs', [])]));
    projectionState.update('bans', 'released', 'released');

    expect(service.bannedView('!room:hs')).toEqual({
      availability: 'unavailable',
      current: null,
      stale: null,
    });
  });
});
