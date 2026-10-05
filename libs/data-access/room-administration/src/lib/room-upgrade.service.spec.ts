import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MatrixEvent, type IEvent } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import {
  RoomActionPermissionError,
  RoomActionPermissionsService,
  type ActionAvailability,
} from './room-action-permissions.service';
import {
  RoomUpgradeService,
  roomUpgradeTargets,
  type RoomUpgradeCapabilities,
} from './room-upgrade.service';

const ME = '@me:hs';
const OLD = '!old:hs';
const NEW = '!new:hs';

const CAPS: RoomUpgradeCapabilities = {
  defaultRoomVersion: '10',
  roomVersions: {
    '9': 'stable',
    '10': 'stable',
    '11': 'stable',
    '12': 'stable',
    'org.example.v13': 'unstable',
  },
};

interface FakeRoomOptions {
  readonly events?: readonly Partial<IEvent>[];
  /** `[userId, membership]` pairs. */
  readonly members?: readonly (readonly [string, string])[];
  readonly space?: boolean;
  /** What `maySendStateEvent` answers for me. */
  readonly mayEdit?: boolean;
  readonly myMembership?: string;
  readonly name?: string;
  /** False: the live timeline has no state at all. */
  readonly loaded?: boolean;
}

function fakeRoom(roomId: string, o: FakeRoomOptions = {}) {
  const events = (o.events ?? []).map(
    (raw) =>
      new MatrixEvent({
        state_key: '',
        sender: ME,
        room_id: roomId,
        origin_server_ts: 1,
        ...raw,
      }),
  );
  const state = {
    getStateEvents: (type: string, stateKey?: string) =>
      stateKey === undefined
        ? events.filter((e) => e.getType() === type)
        : (events.find(
            (e) => e.getType() === type && e.getStateKey() === stateKey,
          ) ?? null),
    getJoinRule: () =>
      events.find((e) => e.getType() === 'm.room.join_rules')?.getContent()[
        'join_rule'
      ] ?? 'invite',
    maySendStateEvent: () => o.mayEdit ?? true,
    getMember: () => null,
  };
  const members = (o.members ?? []).map(([userId, membership]) => ({
    userId,
    membership,
  }));
  return {
    roomId,
    name: o.name ?? roomId,
    isSpaceRoom: () => o.space ?? false,
    getMyMembership: () => o.myMembership ?? 'join',
    getMembers: () => members,
    getMember: (userId: string) =>
      members.find((m) => m.userId === userId) ?? null,
    getLiveTimeline: () => ({
      getState: () => (o.loaded === false ? undefined : state),
    }),
  };
}

type FakeRoom = ReturnType<typeof fakeRoom>;

const create = (
  version: string,
  extra: Record<string, unknown> = {},
  sender = ME,
): Partial<IEvent> => ({
  type: 'm.room.create',
  sender,
  content: { room_version: version, ...extra },
});
const joinRule = (rule: string): Partial<IEvent> => ({
  type: 'm.room.join_rules',
  content: { join_rule: rule },
});
const child = (
  childId: string,
  content: Record<string, unknown>,
): Partial<IEvent> => ({
  type: 'm.space.child',
  state_key: childId,
  content,
});
const parent = (spaceId: string): Partial<IEvent> => ({
  type: 'm.space.parent',
  state_key: spaceId,
  content: { via: ['hs'] },
});

function setup(
  rooms: readonly FakeRoom[],
  opts: { upgrade?: ActionAvailability } = {},
) {
  const upgradeRoom = vi.fn().mockResolvedValue({ replacement_room: NEW });
  const invite = vi.fn().mockResolvedValue({});
  const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$e' });
  const leave = vi.fn().mockResolvedValue({});
  const client = {
    upgradeRoom,
    invite,
    sendStateEvent,
    leave,
    getUserId: () => ME,
    getDomain: () => 'hs',
    getRoom: (roomId: string) => rooms.find((r) => r.roomId === roomId) ?? null,
    getRooms: () => rooms,
  };
  const settingsFor = vi.fn(() => ({
    upgrade: opts.upgrade ?? { available: true, reason: null },
  }));
  TestBed.configureTestingModule({
    providers: [
      RoomUpgradeService,
      MockProvider(MatrixClientService, {
        clientFor: (accountId: string) =>
          accountId === ME ? (client as never) : null,
      }),
      MockProvider(RoomActionPermissionsService, {
        settingsFor: settingsFor as never,
        assert: (availability: ActionAvailability) => {
          if (!availability.available) {
            throw new RoomActionPermissionError(availability);
          }
        },
      }),
    ],
  });
  return {
    svc: TestBed.inject(RoomUpgradeService),
    client,
    upgradeRoom,
    invite,
    sendStateEvent,
    leave,
    settingsFor,
  };
}

describe('roomUpgradeTargets', () => {
  it('offers stable whole-number versions newer than the room, ascending', () => {
    expect(roomUpgradeTargets('10', CAPS)).toEqual([
      { version: '11', isDefault: false },
      { version: '12', isDefault: false },
    ]);
    // Numeric, not string, order: '10' sorts after '9'.
    expect(roomUpgradeTargets('9', CAPS)).toEqual([
      { version: '10', isDefault: true },
      { version: '11', isDefault: false },
      { version: '12', isDefault: false },
    ]);
  });

  it('offers nothing to a v12 room on a server defaulting to v10', () => {
    expect(roomUpgradeTargets('12', CAPS)).toEqual([]);
  });

  it('never offers an unstable default', () => {
    expect(
      roomUpgradeTargets('10', {
        defaultRoomVersion: '13',
        roomVersions: { '11': 'stable', '13': 'unstable' },
      }),
    ).toEqual([{ version: '11', isDefault: false }]);
  });

  it('offers nothing when the capabilities or the room version are unknown', () => {
    expect(roomUpgradeTargets('10', null)).toEqual([]);
    expect(
      roomUpgradeTargets('10', {
        defaultRoomVersion: null,
        roomVersions: null,
      }),
    ).toEqual([]);
    expect(roomUpgradeTargets(null, CAPS)).toEqual([]);
  });

  it('trusts a default the server does not label', () => {
    expect(
      roomUpgradeTargets('10', {
        defaultRoomVersion: '11',
        roomVersions: null,
      }),
    ).toEqual([{ version: '11', isDefault: true }]);
  });

  it('treats an unstable room version as older than every stable one', () => {
    expect(
      roomUpgradeTargets('org.example.v13', CAPS).map((t) => t.version),
    ).toEqual(['9', '10', '11', '12']);
  });
});

describe('RoomUpgradeService.plan', () => {
  it('reads the version, targets, private default and members', () => {
    const { svc } = setup([
      fakeRoom(OLD, {
        events: [create('10'), joinRule('invite')],
        members: [
          [ME, 'join'],
          ['@bob:hs', 'join'],
          ['@carol:hs', 'invite'],
          ['@dan:hs', 'leave'],
          ['@eve:hs', 'ban'],
        ],
      }),
    ]);

    expect(svc.plan(ME, OLD, CAPS)).toEqual({
      currentVersion: '10',
      targets: [
        { version: '11', isDefault: false },
        { version: '12', isDefault: false },
      ],
      invitePrivateDefault: true,
      members: ['@bob:hs', '@carol:hs'],
      spaces: [],
      additionalCreators: [],
    });
  });

  it.each([
    ['invite', true],
    ['knock', true],
    ['public', false],
    ['restricted', false],
  ])('defaults the invite for join rule %s to %s', (rule, expected) => {
    const { svc } = setup([
      fakeRoom(OLD, { events: [create('10'), joinRule(rule)] }),
    ]);

    expect(svc.plan(ME, OLD, CAPS)?.invitePrivateDefault).toBe(expected);
  });

  it('treats a room with no join rule as invite-only', () => {
    const { svc } = setup([fakeRoom(OLD, { events: [create('10')] })]);

    expect(svc.plan(ME, OLD, CAPS)?.invitePrivateDefault).toBe(true);
  });

  it('carries the old room’s other creators', () => {
    const { svc } = setup([
      fakeRoom(OLD, {
        events: [
          create('12', { additional_creators: [ME, '@carol:hs'] }, '@alice:hs'),
        ],
      }),
    ]);

    expect(svc.plan(ME, OLD, CAPS)?.additionalCreators).toEqual([
      '@alice:hs',
      '@carol:hs',
    ]);
  });

  it('lists the spaces that link the room and whether they can be re-linked', () => {
    const { svc } = setup([
      fakeRoom(OLD, { events: [create('10'), parent('!pending:hs')] }),
      fakeRoom('!design:hs', {
        name: 'Design',
        space: true,
        events: [create('10'), child(OLD, { via: ['hs'] })],
      }),
      fakeRoom('!readonly:hs', {
        name: 'Read only',
        space: true,
        mayEdit: false,
        events: [create('10'), child(OLD, { via: ['hs'] })],
      }),
      fakeRoom('!unlinked:hs', {
        name: 'Unlinked',
        space: true,
        events: [create('10'), child('!other:hs', { via: ['hs'] })],
      }),
      fakeRoom('!removed:hs', {
        name: 'Removed',
        space: true,
        events: [create('10'), child(OLD, { via: [] })],
      }),
      fakeRoom('!left:hs', {
        name: 'Left',
        space: true,
        myMembership: 'leave',
        events: [create('10'), child(OLD, { via: ['hs'] })],
      }),
      fakeRoom('!plain:hs', {
        name: 'Plain room',
        events: [create('10'), child(OLD, { via: ['hs'] })],
      }),
      fakeRoom('!pending:hs', { name: 'Pending', loaded: false }),
    ]);

    expect(svc.plan(ME, OLD, CAPS)?.spaces).toEqual([
      { spaceId: '!design:hs', name: 'Design', relinkable: true },
      {
        spaceId: '!readonly:hs',
        name: 'Read only',
        relinkable: false,
        reason: 'no permission',
      },
      {
        spaceId: '!pending:hs',
        name: 'Pending',
        relinkable: false,
        reason: 'state not loaded',
      },
    ]);
  });

  it('is null for an unknown Account or room', () => {
    const { svc } = setup([fakeRoom(OLD, { events: [create('10')] })]);

    expect(svc.plan('@other:hs', OLD, CAPS)).toBeNull();
    expect(svc.plan(ME, '!missing:hs', CAPS)).toBeNull();
  });
});
