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

function knockingMember(
  userId: string,
  name: string,
  reason?: string,
  avatarMxc?: string,
) {
  return {
    ...bannedMember(userId, name, reason),
    getMxcAvatarUrl: () => avatarMxc,
  };
}

function room(
  roomId: string,
  members: ReturnType<typeof member>[],
  creator: string | null = null,
  banned: ReturnType<typeof bannedMember>[] = [],
  invited: ReturnType<typeof member>[] = [],
  knocking: ReturnType<typeof knockingMember>[] = [],
) {
  return {
    roomId,
    getMyMembership: () => 'join',
    getJoinedMembers: vi.fn(() => members),
    getMembersWithMembership: vi.fn((membership: string) =>
      membership === 'invite'
        ? invited
        : membership === 'ban'
          ? banned
          : membership === 'knock'
            ? knocking
            : [],
    ),
    getCreator: () => creator,
    loadMembersIfNeeded: vi.fn(() => Promise.resolve(true)),
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
  it('loads the full member list of the room it observes (#1295)', () => {
    const target = room('!shared:hs', [member('@ada:hs', 'Ada')]);
    const opening = client([target]);
    TestBed.configureTestingModule({
      providers: [
        RoomMembersService,
        MockProvider(MatrixClientService, {
          accountIds: signal<readonly string[]>(['@opening:hs']).asReadonly(),
          activeUserId: signal<string | null>('@opening:hs').asReadonly(),
          clientFor: () => opening as unknown as MatrixClient,
        }),
      ],
    });
    const observation = TestBed.inject(RoomMembersService)
      .observe({ accountId: '@opening:hs', roomId: '!shared:hs' })
      .subscribe();
    TestBed.inject(ApplicationRef).tick();

    // A lazily synced room lists only the members its loaded events named; the settings
    // member and ban lists need all of them. Arriving members re-publish through the
    // RoomState.members listener.
    expect(target.loadMembersIfNeeded).toHaveBeenCalledOnce();
    observation.unsubscribe();
  });

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

  it('projects invited members apart from joined ones and follows member events', async () => {
    const invited = [member('@zoe:hs', 'Zoe'), member('@ann:hs', 'Ann')];
    const source = room(
      '!room:hs',
      [member('@me:hs', 'Me')],
      null,
      [],
      invited,
    );
    const matrixClient = client([source]);
    const { service } = setup(matrixClient);
    const pending = service.invitedFor('!room:hs');

    expect(pending().map((m) => m.userId)).toEqual(['@ann:hs', '@zoe:hs']);
    expect(
      service
        .membersFor('!room:hs')()
        .map((m) => m.userId),
    ).toEqual(['@me:hs']);

    invited.splice(0, 1);
    fireMemberChange(matrixClient, '!room:hs');
    await Promise.resolve();

    expect(pending().map((m) => m.userId)).toEqual(['@ann:hs']);
  });

  it('projects knocks with reasons, sorted', () => {
    const source = room(
      '!room:hs',
      [],
      null,
      [],
      [],
      [
        knockingMember('@zed:hs', 'Zed', 'From the meetup', 'mxc://hs/zed'),
        knockingMember('@amy:hs', 'Amy', ''),
      ],
    );
    const { service } = setup(client([source]));

    expect(service.knockingFor('!room:hs')()).toEqual([
      {
        userId: '@amy:hs',
        roomDisplayName: 'Amy',
        roomInitial: 'A',
        roomAvatarMxc: null,
        reason: null,
      },
      {
        userId: '@zed:hs',
        roomDisplayName: 'Zed',
        roomInitial: 'Z',
        roomAvatarMxc: 'mxc://hs/zed',
        reason: 'From the meetup',
      },
    ]);
  });

  it('drops a withdrawn knock on the next member event', async () => {
    const knocking = [knockingMember('@amy:hs', 'Amy')];
    const matrixClient = client([room('!room:hs', [], null, [], [], knocking)]);
    const { service } = setup(matrixClient);
    const requests = service.knockingFor('!room:hs');
    expect(requests()).toHaveLength(1);

    knocking.splice(0, 1);
    fireMemberChange(matrixClient, '!room:hs');
    await Promise.resolve();

    expect(requests()).toEqual([]);
  });

  it('clears knocks on account reset', async () => {
    const matrixClient = client([
      room('!room:hs', [], null, [], [], [knockingMember('@amy:hs', 'Amy')]),
    ]);
    const { service, lifetime } = setup(matrixClient);
    const requests = service.knockingFor('!room:hs');
    expect(requests()).toHaveLength(1);

    lifetime.unsubscribe();
    TestBed.inject(ApplicationRef).tick();
    await Promise.resolve();

    expect(requests()).toEqual([]);
  });

  it('carries invited and knocking in the snapshot of an available exact target', () => {
    const source = room(
      '!room:hs',
      [member('@me:hs', 'Me')],
      null,
      [],
      [member('@ann:hs', 'Ann')],
      [knockingMember('@amy:hs', 'Amy', 'Hi')],
    );
    const matrixClient = client([source]);
    const matrix = {
      clientFor: () => matrixClient as unknown as MatrixClient,
    };
    TestBed.configureTestingModule({
      providers: [
        RoomMembersService,
        MockProvider(MatrixClientService, matrix),
      ],
    });
    const snapshot = TestBed.inject(RoomMembersService).snapshot({
      accountId: '@me:hs',
      roomId: '!room:hs',
    });

    expect(snapshot.members.map((m) => m.userId)).toEqual(['@me:hs']);
    expect(snapshot.invited.map((m) => m.userId)).toEqual(['@ann:hs']);
    expect(snapshot.knocking.map((k) => k.reason)).toEqual(['Hi']);
  });

  it('leaves invited and knocking empty when the room is unavailable', () => {
    const source = {
      ...room('!room:hs', [], null, [], [member('@ann:hs', 'Ann')]),
      getMyMembership: () => 'leave',
    };
    const matrixClient = client([source]);
    TestBed.configureTestingModule({
      providers: [
        RoomMembersService,
        MockProvider(MatrixClientService, {
          clientFor: () => matrixClient as unknown as MatrixClient,
        }),
      ],
    });
    const snapshot = TestBed.inject(RoomMembersService).snapshot({
      accountId: '@me:hs',
      roomId: '!room:hs',
    });

    expect(snapshot.availability).toBe('room-unavailable');
    expect(snapshot.invited).toEqual([]);
    expect(snapshot.knocking).toEqual([]);
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
