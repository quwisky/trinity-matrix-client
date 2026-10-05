import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MatrixEvent, type IEvent } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  RoomActionPermissionError,
  RoomActionPermissionsService,
  type ActionAvailability,
} from './room-action-permissions.service';
import { RoomAdministrationError } from './room-administration-error';
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

describe('RoomUpgradeService.upgrade', () => {
  const rooms = (extra: readonly FakeRoom[] = []) => [
    fakeRoom(OLD, {
      events: [create('10'), joinRule('invite')],
      members: [
        [ME, 'join'],
        ['@bob:hs', 'join'],
        ['@carol:hs', 'invite'],
      ],
    }),
    fakeRoom('!design:hs', {
      name: 'Design',
      space: true,
      events: [
        create('10'),
        child(OLD, { via: ['other.hs'], order: 'a', suggested: true }),
      ],
    }),
    ...extra,
  ];
  const rejection = (svc: RoomUpgradeService, accountId = ME) =>
    firstValueFrom(
      svc.upgrade(accountId, OLD, { version: '11', inviteMembers: true }),
    ).catch((error: unknown) => error);

  it('is cold, then upgrades, invites and moves the space link in order', async () => {
    const { svc, upgradeRoom, invite, sendStateEvent } = setup(rooms());

    const action = svc.upgrade(ME, OLD, { version: '11', inviteMembers: true });
    expect(upgradeRoom).not.toHaveBeenCalled();

    await expect(firstValueFrom(action)).resolves.toEqual({
      newRoomId: NEW,
      invited: ['@bob:hs', '@carol:hs'],
      inviteFailed: [],
      relinked: ['!design:hs'],
      relinkFailed: [],
      skippedSpaces: [],
    });
    expect(upgradeRoom).toHaveBeenCalledWith(OLD, '11', undefined);
    expect(invite.mock.calls).toEqual([
      [NEW, '@bob:hs'],
      [NEW, '@carol:hs'],
    ]);
    expect(sendStateEvent.mock.calls).toEqual([
      [
        '!design:hs',
        'm.space.child',
        { via: ['other.hs', 'hs'], order: 'a', suggested: true },
        NEW,
      ],
      ['!design:hs', 'm.space.child', {}, OLD],
    ]);
    expect(upgradeRoom.mock.invocationCallOrder[0]).toBeLessThan(
      invite.mock.invocationCallOrder[0],
    );
    expect(invite.mock.invocationCallOrder[1]).toBeLessThan(
      sendStateEvent.mock.invocationCallOrder[0],
    );
  });

  it('invites nobody when asked not to', async () => {
    const { svc, invite } = setup(rooms());

    const result = await firstValueFrom(
      svc.upgrade(ME, OLD, { version: '11', inviteMembers: false }),
    );

    expect(invite).not.toHaveBeenCalled();
    expect(result.invited).toEqual([]);
  });

  it('skips members already in the new room', async () => {
    const { svc, invite } = setup(
      rooms([fakeRoom(NEW, { members: [['@carol:hs', 'invite']] })]),
    );

    await firstValueFrom(
      svc.upgrade(ME, OLD, { version: '11', inviteMembers: true }),
    );

    expect(invite.mock.calls).toEqual([[NEW, '@bob:hs']]);
  });

  it.each([
    ['11', undefined],
    ['12', ['@alice:hs']],
  ])(
    'to version %s passes additional creators %j',
    async (version, creators) => {
      const { svc, upgradeRoom } = setup([
        fakeRoom(OLD, { events: [create('10', {}, '@alice:hs')] }),
      ]);

      await firstValueFrom(
        svc.upgrade(ME, OLD, { version, inviteMembers: false }),
      );

      expect(upgradeRoom).toHaveBeenCalledWith(OLD, version, creators);
    },
  );

  it('uses the new room’s server from the Account for a v12 room ID', async () => {
    const { svc, upgradeRoom, sendStateEvent } = setup(rooms());
    upgradeRoom.mockResolvedValueOnce({ replacement_room: '!opaqueid' });

    await firstValueFrom(
      svc.upgrade(ME, OLD, { version: '12', inviteMembers: false }),
    );

    expect(sendStateEvent.mock.calls[0]).toEqual([
      '!design:hs',
      'm.space.child',
      { via: ['other.hs', 'hs'], order: 'a', suggested: true },
      '!opaqueid',
    ]);
  });

  it('reports each failed invite and keeps going', async () => {
    const { svc, invite } = setup(rooms());
    invite.mockRejectedValueOnce(new Error('M_FORBIDDEN: blocked'));

    const result = await firstValueFrom(
      svc.upgrade(ME, OLD, { version: '11', inviteMembers: true }),
    );

    expect(result.invited).toEqual(['@carol:hs']);
    expect(result.inviteFailed).toEqual([
      { userId: '@bob:hs', reason: 'M_FORBIDDEN: blocked' },
    ]);
    expect(result.relinked).toEqual(['!design:hs']);
  });

  it('keeps the old link when the new one cannot be written', async () => {
    const { svc, sendStateEvent } = setup(rooms());
    sendStateEvent.mockRejectedValueOnce(new Error('M_FORBIDDEN: no'));

    const result = await firstValueFrom(
      svc.upgrade(ME, OLD, { version: '11', inviteMembers: false }),
    );

    expect(sendStateEvent).toHaveBeenCalledTimes(1);
    expect(result.relinked).toEqual([]);
    expect(result.relinkFailed).toEqual([
      { spaceId: '!design:hs', reason: 'M_FORBIDDEN: no', linkedTwice: false },
    ]);
  });

  it('reports a space that now links both rooms', async () => {
    const { svc, sendStateEvent } = setup(rooms());
    sendStateEvent
      .mockResolvedValueOnce({ event_id: '$new' })
      .mockRejectedValueOnce(new Error('M_LIMIT_EXCEEDED'));

    const result = await firstValueFrom(
      svc.upgrade(ME, OLD, { version: '11', inviteMembers: false }),
    );

    expect(result.relinked).toEqual([]);
    expect(result.relinkFailed).toEqual([
      { spaceId: '!design:hs', reason: 'M_LIMIT_EXCEEDED', linkedTwice: true },
    ]);
  });

  it('leaves spaces it cannot edit, and removed links, alone', async () => {
    const { svc, sendStateEvent } = setup([
      fakeRoom(OLD, { events: [create('10')] }),
      fakeRoom('!readonly:hs', {
        name: 'Read only',
        space: true,
        mayEdit: false,
        events: [create('10'), child(OLD, { via: ['hs'] })],
      }),
      fakeRoom('!removed:hs', {
        name: 'Removed',
        space: true,
        events: [create('10'), child(OLD, { via: [] })],
      }),
    ]);

    const result = await firstValueFrom(
      svc.upgrade(ME, OLD, { version: '11', inviteMembers: false }),
    );

    expect(sendStateEvent).not.toHaveBeenCalled();
    expect(result.skippedSpaces).toEqual([
      {
        spaceId: '!readonly:hs',
        name: 'Read only',
        relinkable: false,
        reason: 'no permission',
      },
    ]);
  });

  it('stops everything when the server rejects the upgrade', async () => {
    const { svc, upgradeRoom, invite, sendStateEvent } = setup(rooms());
    upgradeRoom.mockRejectedValueOnce(new Error('M_UNSUPPORTED_ROOM_VERSION'));

    const error = await rejection(svc);

    expect(error).toBeInstanceOf(RoomAdministrationError);
    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'server-rejected',
      operation: 'upgrade-room',
    });
    expect(invite).not.toHaveBeenCalled();
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('refuses without permission to send the tombstone', async () => {
    const { svc, upgradeRoom } = setup(rooms(), {
      upgrade: {
        available: false,
        reason: "Your role cannot change this room's version.",
      },
    });

    const error = await rejection(svc);

    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'permission-denied',
    );
    expect(upgradeRoom).not.toHaveBeenCalled();
  });

  it('refuses when the opening Account is gone', async () => {
    const { svc, upgradeRoom } = setup(rooms());

    const error = await rejection(svc, '@other:hs');

    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'not-signed-in',
    );
    expect(upgradeRoom).not.toHaveBeenCalled();
  });

  it('never rolls back once the new room exists', async () => {
    const { svc, invite, sendStateEvent, leave } = setup(rooms());
    invite.mockRejectedValue(new Error('down'));
    sendStateEvent.mockRejectedValue(new Error('down'));

    const result = await firstValueFrom(
      svc.upgrade(ME, OLD, { version: '11', inviteMembers: true }),
    );

    expect(result.newRoomId).toBe(NEW);
    expect(result.inviteFailed).toHaveLength(2);
    expect(result.relinkFailed).toHaveLength(1);
    // One attempted write per space and nothing that undoes the upgrade.
    expect(sendStateEvent).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
  });

  it('runs each request only after the previous one settles', async () => {
    const second = fakeRoom('!ops:hs', {
      name: 'Ops',
      space: true,
      events: [create('10'), child(OLD, { via: ['hs'] })],
    });
    const { svc, invite, sendStateEvent } = setup(rooms([second]));
    const gates: (() => void)[] = [];
    const gated = () => new Promise((resolve) => gates.push(() => resolve({})));
    invite.mockImplementation(gated);
    sendStateEvent.mockImplementation(gated);
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    const done = firstValueFrom(
      svc.upgrade(ME, OLD, { version: '11', inviteMembers: true }),
    );
    const step = async (invites: number, writes: number) => {
      await flush();
      expect(invite).toHaveBeenCalledTimes(invites);
      expect(sendStateEvent).toHaveBeenCalledTimes(writes);
      gates.shift()?.();
    };
    await step(1, 0);
    await step(2, 0);
    await step(2, 1); // first space: new child
    await step(2, 2); // first space: old child cleared
    await step(2, 3); // second space: new child
    await step(2, 4);
    await done;
  });

  it('refuses a room that already has a replacement', async () => {
    const { svc, upgradeRoom, invite, sendStateEvent } = setup([
      fakeRoom(OLD, {
        events: [
          create('10'),
          { type: 'm.room.tombstone', content: { replacement_room: NEW } },
        ],
      }),
    ]);

    const error = await rejection(svc);

    expect(error).toBeInstanceOf(RoomAdministrationError);
    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'invalid-input',
      operation: 'upgrade-room',
    });
    expect(upgradeRoom).not.toHaveBeenCalled();
    expect(invite).not.toHaveBeenCalled();
    expect(sendStateEvent).not.toHaveBeenCalled();
  });
});
