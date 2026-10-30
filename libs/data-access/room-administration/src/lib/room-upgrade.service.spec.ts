import { TestBed } from '@angular/core/testing';
import {
  type EngineFailure,
  type EngineResult,
  engineFail,
  engineOk,
} from '@trinity/util/matrix';
import { Subject, firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeRoomAdministrationEngine } from '../contract/fake-room-administration-engine';
import type { JsonObject, RoomMembers } from './room-administration-engine';
import { RoomAdministrationError } from './room-administration-error';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import {
  administrationSession,
  roomWithAlice,
} from './room-administration.spec-harness';
import {
  RoomUpgradeService,
  roomUpgradeTargets,
  type RoomUpgradeCapabilities,
  type RoomUpgradeOptions,
} from './room-upgrade.service';

const SERVER = 'example.org';

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

/**
 * Alice (at `alicePower`) in a room bob created, with carol invited unless `carol` is
 * false; the permissions projection is coherent.
 */
async function setup({
  alicePower = 100,
  roomVersion = '10',
  additionalCreators,
  carol = true,
}: {
  alicePower?: number;
  roomVersion?: string;
  additionalCreators?: readonly string[];
  carol?: boolean;
} = {}) {
  const session = administrationSession();
  const { engine } = session;
  const roomId = await roomWithAlice(engine, {
    roomVersion,
    additionalCreators,
  });
  await engine.asBob.setPowerLevel(roomId, engine.alice, alicePower);
  if (carol) await engine.asBob.invite(roomId, engine.carol);
  TestBed.configureTestingModule({ providers: session.providers });
  const state = TestBed.inject(RoomAdministrationProjectionState);
  state.select(engine.alice, roomId);
  state.update('permissions', 'available', 'retained');
  return {
    ...session,
    roomId,
    svc: TestBed.inject(RoomUpgradeService),
    upgradeRoom: vi.spyOn(engine, 'upgradeRoom'),
    invite: vi.spyOn(engine, 'invite'),
    setState: vi.spyOn(engine, 'setState'),
  };
}

/** A space bob created and alice joined at `alicePower`, linking `child` with `content`. */
async function space(
  engine: FakeRoomAdministrationEngine,
  name: string,
  child?: { readonly roomId: string; readonly content: JsonObject },
  alicePower = 50,
): Promise<string> {
  const spaceId = await roomWithAlice(engine, { space: true });
  await engine.asBob.setState(spaceId, 'm.room.name', { name });
  if (child) {
    await engine.asBob.setState(
      spaceId,
      'm.space.child',
      child.content,
      child.roomId,
    );
  }
  await engine.asBob.setPowerLevel(spaceId, engine.alice, alicePower);
  return spaceId;
}

const fail = (
  kind: EngineFailure['kind'],
  httpStatus?: number,
): EngineResult<never> =>
  engineFail({
    kind,
    code: 'request-failed',
    diagnostic: { kind, ...(httpStatus ? { httpStatus } : {}) },
  });

const FORBIDDEN_TEXT = 'You do not have permission to do that.';

afterEach(() => TestBed.resetTestingModule());

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
  const planOf = (svc: RoomUpgradeService, accountId: string, roomId: string) =>
    firstValueFrom(svc.plan(accountId, roomId, CAPS));

  it('is cold, then reads the version, targets, private default and members', async () => {
    const { svc, engine, roomId } = await setup();
    const members = vi.spyOn(engine, 'members');

    const plan = svc.plan(engine.alice, roomId, CAPS);
    expect(members).not.toHaveBeenCalled();

    expect(await firstValueFrom(plan)).toEqual({
      currentVersion: '10',
      targets: [
        { version: '11', isDefault: false },
        { version: '12', isDefault: false },
      ],
      invitePrivateDefault: true,
      members: [engine.bob, engine.carol],
      spaces: [],
      // Bob created it and is still joined at alice's power.
      additionalCreators: [engine.bob],
      additionalCreatorNames: [engine.bob],
    });
  });

  it.each(['leave', 'ban'])(
    'leaves out a member whose membership is %s',
    async (membership) => {
      const { svc, engine, roomId } = await setup();
      await engine.asBob.setState(
        roomId,
        'm.room.member',
        { membership },
        engine.carol,
      );

      expect((await planOf(svc, engine.alice, roomId))?.members).toEqual([
        engine.bob,
      ]);
    },
  );

  it('waits for lazily loaded members before planning', async () => {
    const { svc, engine, roomId } = await setup({ carol: false });
    const members = new Subject<RoomMembers | null>();
    vi.spyOn(engine, 'members').mockReturnValue(members);
    const member = (userId: string) => ({
      userId,
      displayName: userId,
      avatarMxc: null,
      membership: 'join' as const,
      reason: null,
      power: 0,
    });
    let planned: string[] | undefined;
    svc.plan(engine.alice, roomId, CAPS).subscribe((plan) => {
      planned = [...(plan?.members ?? [])];
    });

    members.next({ roomId, complete: false, members: [member(engine.alice)] });
    expect(planned).toBeUndefined();
    members.next({
      roomId,
      complete: true,
      members: [member(engine.alice), member(engine.carol)],
    });

    expect(planned).toEqual([engine.carol]);
  });

  it.each([
    ['invite', true],
    ['knock', true],
    ['public', false],
    ['restricted', false],
  ])('defaults the invite for join rule %s to %s', async (rule, expected) => {
    const { svc, engine, roomId } = await setup();
    await engine.asBob.setState(roomId, 'm.room.join_rules', {
      join_rule: rule,
    });

    expect(
      (await planOf(svc, engine.alice, roomId))?.invitePrivateDefault,
    ).toBe(expected);
  });

  it('treats a room with no join rule as invite-only', async () => {
    const { svc, engine, roomId } = await setup();

    expect(
      (await planOf(svc, engine.alice, roomId))?.invitePrivateDefault,
    ).toBe(true);
  });

  it('carries a v12 room’s other creators, named', async () => {
    const session = administrationSession();
    const { engine } = session;
    const roomId = await roomWithAlice(engine, {
      roomVersion: '12',
      additionalCreators: [engine.alice, engine.carol],
    });
    await engine.asBob.setDisplayName(roomId, 'Bob');
    TestBed.configureTestingModule({ providers: session.providers });

    const plan = await planOf(
      TestBed.inject(RoomUpgradeService),
      engine.alice,
      roomId,
    );

    expect(plan?.additionalCreators).toEqual([engine.bob, engine.carol]);
    expect(plan?.additionalCreatorNames).toEqual(['Bob', engine.carol]);
  });

  describe('creators of a pre-v12 room', () => {
    /** Bob created it; alice is at 100; `bob` changes his membership or power. */
    const carried = async (bob?: {
      membership?: JsonObject;
      power?: number;
    }) => {
      const { svc, engine, roomId } = await setup({ carol: false });
      if (bob?.power !== undefined) {
        await engine.asBob.setPowerLevel(roomId, engine.bob, bob.power);
      }
      if (bob?.membership) {
        await engine.asBob.setState(
          roomId,
          'm.room.member',
          bob.membership,
          engine.bob,
        );
      }
      return (await planOf(svc, engine.alice, roomId))?.additionalCreators;
    };

    it('carries one still joined at or above my power', async () => {
      expect(await carried()).toEqual(['@bob:example.org']);
    });

    it.each([
      ['demoted below me', { power: 50 }],
      ['left', { membership: { membership: 'leave' } }],
      ['banned', { membership: { membership: 'ban' } }],
      ['not a member at all', { membership: {} }],
    ])('does not carry one who is %s', async (_label, bob) => {
      expect(await carried(bob)).toEqual([]);
    });
  });

  it('lists the spaces that link the room and whether they can be re-linked', async () => {
    const { svc, engine, roomId } = await setup();
    const linked = { roomId, content: { via: [SERVER] } };
    const design = await space(engine, 'Design', linked);
    const readonly = await space(engine, 'Read only', linked, 0);
    await space(engine, 'Unlinked', {
      roomId: '!other:example.org',
      content: { via: [SERVER] },
    });
    await space(engine, 'Removed', { roomId, content: { via: [] } });
    await space(engine, 'No child');

    expect((await planOf(svc, engine.alice, roomId))?.spaces).toEqual([
      { spaceId: design, name: 'Design', relinkable: true },
      {
        spaceId: readonly,
        name: 'Read only',
        relinkable: false,
        reason: 'no permission',
      },
    ]);
  });

  it('lists a space whose state is not loaded as not relinkable', async () => {
    const { svc, engine, roomId } = await setup();
    vi.spyOn(engine, 'linkingSpaces').mockReturnValue(
      of(
        engineOk([
          {
            spaceId: '!pending:example.org',
            name: 'Pending',
            childContent: null,
            ownPower: 0,
            powerLevels: null,
          },
        ]),
      ),
    );

    expect((await planOf(svc, engine.alice, roomId))?.spaces).toEqual([
      {
        spaceId: '!pending:example.org',
        name: 'Pending',
        relinkable: false,
        reason: 'state not loaded',
      },
    ]);
  });

  it('is null for an unknown Account or room', async () => {
    const { svc, engine, roomId } = await setup();

    expect(await planOf(svc, '@other:example.org', roomId)).toBeNull();
    expect(await planOf(svc, engine.alice, '!missing:example.org')).toBeNull();
  });
});

describe('RoomUpgradeService.upgrade', () => {
  const OPTIONS: RoomUpgradeOptions = { version: '11', inviteMembers: true };

  /** The room plus a space alice may edit that links it with order and suggested. */
  async function linkedSetup(options: Parameters<typeof setup>[0] = {}) {
    const fixture = await setup(options);
    const design = await space(fixture.engine, 'Design', {
      roomId: fixture.roomId,
      content: { via: ['other.hs'], order: 'a', suggested: true },
    });
    return { ...fixture, design };
  }

  const run = (
    svc: RoomUpgradeService,
    accountId: string,
    roomId: string,
    options: RoomUpgradeOptions = OPTIONS,
  ) => firstValueFrom(svc.upgrade(accountId, roomId, options));

  const rejection = (action: Promise<unknown>) =>
    action.then(
      () => null,
      (error: unknown) => error,
    );

  it('is cold, then upgrades, invites and moves the space link in order', async () => {
    const { svc, engine, roomId, design, upgradeRoom, invite, setState } =
      await linkedSetup();

    const action = svc.upgrade(engine.alice, roomId, OPTIONS);
    expect(upgradeRoom).not.toHaveBeenCalled();

    const result = await firstValueFrom(action);
    const newRoomId = result.newRoomId;
    expect(result).toEqual({
      newRoomId,
      invited: [engine.bob, engine.carol],
      inviteFailed: [],
      relinked: [design],
      relinkFailed: [],
      skippedSpaces: [],
    });
    expect(upgradeRoom).toHaveBeenCalledWith(engine.alice, roomId, '11', null);
    expect(invite.mock.calls).toEqual([
      [engine.alice, newRoomId, engine.bob],
      [engine.alice, newRoomId, engine.carol],
    ]);
    expect(setState.mock.calls).toEqual([
      [
        engine.alice,
        design,
        'm.space.child',
        newRoomId,
        { via: ['other.hs', SERVER], order: 'a', suggested: true },
      ],
      [engine.alice, design, 'm.space.child', roomId, {}],
    ]);
    expect(upgradeRoom.mock.invocationCallOrder[0]).toBeLessThan(
      invite.mock.invocationCallOrder[0],
    );
    expect(invite.mock.invocationCallOrder[1]).toBeLessThan(
      setState.mock.invocationCallOrder[0],
    );
  });

  it('loads the full member list before choosing who to invite (#1295)', async () => {
    const { svc, engine, roomId, invite } = await setup({ carol: false });
    const real = engine.members.bind(engine);
    const members = new Subject<RoomMembers | null>();
    vi.spyOn(engine, 'members').mockImplementation((accountId, id) =>
      id === roomId ? members : real(accountId, id),
    );
    const done = run(svc, engine.alice, roomId);
    const member = (userId: string) => ({
      userId,
      displayName: userId,
      avatarMxc: null,
      membership: 'join' as const,
      reason: null,
      power: 0,
    });

    members.next({ roomId, complete: false, members: [member(engine.bob)] });
    members.next({
      roomId,
      complete: true,
      members: [member(engine.bob), member(engine.carol)],
    });
    await done;

    expect(invite.mock.calls.map(([, , userId]) => userId)).toEqual([
      engine.bob,
      engine.carol,
    ]);
  });

  it('invites nobody when asked not to', async () => {
    const { svc, engine, roomId, invite } = await setup();

    const result = await run(svc, engine.alice, roomId, {
      version: '11',
      inviteMembers: false,
    });

    expect(invite).not.toHaveBeenCalled();
    expect(result.invited).toEqual([]);
  });

  it('skips members already in the new room', async () => {
    const { svc, engine, roomId, invite } = await setup();
    const real = engine.members.bind(engine);
    vi.spyOn(engine, 'members').mockImplementation((accountId, id) =>
      id === roomId
        ? real(accountId, id)
        : of({
            roomId: id,
            complete: true,
            members: [
              {
                userId: engine.carol,
                displayName: engine.carol,
                avatarMxc: null,
                membership: 'invite',
                reason: null,
                power: 0,
              },
            ],
          }),
    );

    await run(svc, engine.alice, roomId);

    expect(invite.mock.calls.map(([, , userId]) => userId)).toEqual([
      engine.bob,
    ]);
  });

  it.each([
    ['10', '11', null],
    ['10', '12', ['@bob:example.org']],
    ['12', '12', ['@bob:example.org']],
    ['12', '13', ['@bob:example.org']],
    ['11', '11', null],
  ])(
    'from v%s to version %s passes additional creators %j',
    async (roomVersion, version, creators) => {
      const { svc, engine, roomId, upgradeRoom } = await setup({
        roomVersion,
        carol: false,
      });

      await run(svc, engine.alice, roomId, {
        version,
        inviteMembers: false,
      }).catch(() => undefined);

      expect(upgradeRoom).toHaveBeenCalledWith(
        engine.alice,
        roomId,
        version,
        creators,
      );
    },
  );

  it('rejects a second upgrade of the same room while one is in flight', async () => {
    const { svc, engine, roomId, upgradeRoom } = await setup();
    const answer = new Subject<
      EngineResult<{ readonly replacementRoomId: string }>
    >();
    upgradeRoom.mockReturnValueOnce(answer);
    const options = { version: '11', inviteMembers: false };

    const first = run(svc, engine.alice, roomId, options);
    await expect(run(svc, engine.alice, roomId, options)).rejects.toMatchObject(
      { outcome: { failure: 'invalid-input', operation: 'upgrade-room' } },
    );
    expect(upgradeRoom).toHaveBeenCalledTimes(1);

    answer.next(engineOk({ replacementRoomId: '!new:example.org' }));
    answer.complete();
    await first;
    await run(svc, engine.alice, roomId, options);
    expect(upgradeRoom).toHaveBeenCalledTimes(2);
  });

  it('frees the room when the upgrade fails or is unsubscribed', async () => {
    const { svc, engine, roomId, upgradeRoom } = await setup();
    const options = { version: '11', inviteMembers: false };
    upgradeRoom.mockReturnValueOnce(of(fail('server', 500)));
    await expect(run(svc, engine.alice, roomId, options)).rejects.toThrow();
    upgradeRoom.mockReturnValueOnce(new Subject());
    const inFlight = svc.upgrade(engine.alice, roomId, options).subscribe();
    expect(upgradeRoom).toHaveBeenCalledTimes(2);
    inFlight.unsubscribe();

    await run(svc, engine.alice, roomId, options);
    expect(upgradeRoom).toHaveBeenCalledTimes(3);
  });

  it('uses the new room’s server from the Account for a v12 room ID', async () => {
    const { svc, engine, roomId, design, upgradeRoom, setState } =
      await linkedSetup();
    upgradeRoom.mockReturnValueOnce(
      of(engineOk({ replacementRoomId: '!opaqueid' })),
    );

    await run(svc, engine.alice, roomId, {
      version: '12',
      inviteMembers: false,
    });

    expect(setState.mock.calls[0]).toEqual([
      engine.alice,
      design,
      'm.space.child',
      '!opaqueid',
      { via: ['other.hs', SERVER], order: 'a', suggested: true },
    ]);
  });

  it('reports each failed invite with the engine’s text and keeps going', async () => {
    const { svc, engine, roomId, design, invite } = await linkedSetup();
    invite.mockReturnValueOnce(of(fail('permission', 403)));

    const result = await run(svc, engine.alice, roomId);

    expect(result.invited).toEqual([engine.carol]);
    expect(result.inviteFailed).toEqual([
      { userId: engine.bob, reason: FORBIDDEN_TEXT },
    ]);
    expect(result.relinked).toEqual([design]);
  });

  it('keeps the old link when the new one cannot be written', async () => {
    const { svc, engine, roomId, design, setState } = await linkedSetup();
    setState.mockReturnValueOnce(of(fail('permission', 403)));

    const result = await run(svc, engine.alice, roomId, {
      version: '11',
      inviteMembers: false,
    });

    expect(setState).toHaveBeenCalledTimes(1);
    expect(result.relinked).toEqual([]);
    expect(result.relinkFailed).toEqual([
      { spaceId: design, reason: FORBIDDEN_TEXT, linkedTwice: false },
    ]);
  });

  it('reports a space that now links both rooms', async () => {
    const { svc, engine, roomId, design, setState } = await linkedSetup();
    setState
      .mockReturnValueOnce(of(engineOk(null)))
      .mockReturnValueOnce(of(fail('rate-limit', 429)));

    const result = await run(svc, engine.alice, roomId, {
      version: '11',
      inviteMembers: false,
    });

    expect(result.relinked).toEqual([]);
    expect(result.relinkFailed).toEqual([
      {
        spaceId: design,
        reason: 'Too many requests. Try again shortly.',
        linkedTwice: true,
      },
    ]);
  });

  it('leaves spaces it cannot edit, and removed links, alone', async () => {
    const { svc, engine, roomId, setState } = await setup();
    const readonly = await space(
      engine,
      'Read only',
      { roomId, content: { via: [SERVER] } },
      0,
    );
    await space(engine, 'Removed', { roomId, content: { via: [] } });

    const result = await run(svc, engine.alice, roomId, {
      version: '11',
      inviteMembers: false,
    });

    expect(setState).not.toHaveBeenCalled();
    expect(result.skippedSpaces).toEqual([
      {
        spaceId: readonly,
        name: 'Read only',
        relinkable: false,
        reason: 'no permission',
      },
    ]);
  });

  it('stops everything when the server rejects the upgrade', async () => {
    const { svc, engine, roomId, upgradeRoom, invite, setState } =
      await linkedSetup();
    upgradeRoom.mockReturnValueOnce(of(fail('http', 400)));

    const error = await rejection(run(svc, engine.alice, roomId));

    expect(error).toBeInstanceOf(RoomAdministrationError);
    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'server-rejected',
      operation: 'upgrade-room',
    });
    expect(invite).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });

  it('refuses without permission to send the tombstone', async () => {
    const { svc, engine, roomId, upgradeRoom } = await setup({
      alicePower: 0,
    });

    const error = await rejection(run(svc, engine.alice, roomId));

    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'permission-denied',
    );
    expect(upgradeRoom).not.toHaveBeenCalled();
  });

  it('refuses when the opening Account is gone', async () => {
    const { svc, engine, roomId, upgradeRoom, signIn } = await setup();
    signIn([]);

    const error = await rejection(run(svc, engine.alice, roomId));

    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'not-signed-in',
    );
    expect(upgradeRoom).not.toHaveBeenCalled();
  });

  it('never rolls back once the new room exists', async () => {
    const { svc, engine, roomId, invite, setState } = await linkedSetup();
    invite.mockReturnValue(of(fail('network')));
    setState.mockReturnValue(of(fail('network')));

    const result = await run(svc, engine.alice, roomId);

    expect(result.inviteFailed).toHaveLength(2);
    expect(result.relinkFailed).toHaveLength(1);
    // One attempted write per space and nothing that undoes the upgrade.
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it('runs each request only after the previous one settles', async () => {
    const { svc, engine, roomId, invite, setState } = await linkedSetup();
    await space(engine, 'Ops', { roomId, content: { via: [SERVER] } });
    const gates: (() => void)[] = [];
    const gated = () => {
      const answer = new Subject<EngineResult<null>>();
      gates.push(() => {
        answer.next(engineOk(null));
        answer.complete();
      });
      return answer;
    };
    invite.mockImplementation(gated);
    setState.mockImplementation(gated);
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    const done = run(svc, engine.alice, roomId);
    const step = async (invites: number, writes: number) => {
      await flush();
      expect(invite).toHaveBeenCalledTimes(invites);
      expect(setState).toHaveBeenCalledTimes(writes);
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
    const { svc, engine, roomId, upgradeRoom, invite, setState } =
      await setup();
    await engine.asBob.setState(roomId, 'm.room.tombstone', {
      replacement_room: '!new:example.org',
    });

    const error = await rejection(run(svc, engine.alice, roomId));

    expect(error).toBeInstanceOf(RoomAdministrationError);
    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'invalid-input',
      operation: 'upgrade-room',
    });
    expect(upgradeRoom).not.toHaveBeenCalled();
    expect(invite).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });
});
