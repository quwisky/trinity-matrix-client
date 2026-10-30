import { computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { firstValueFrom, filter } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Membership } from './room-administration-engine';
import {
  RoomActionPermissionError,
  RoomActionPermissionsService,
} from './room-action-permissions.service';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import {
  administrationSession,
  roomWithAlice,
} from './room-administration.spec-harness';

interface Options {
  readonly myPower?: number;
  readonly targetPower?: number;
  readonly targetMembership?: Membership;
}

/**
 * Alice (`myPower`) and carol, the target, in a room bob created, with invite, kick, ban
 * and state thresholds of 50.
 */
async function setup({
  myPower = 50,
  targetPower = 0,
  targetMembership = 'join',
}: Options = {}) {
  const session = administrationSession();
  const { engine } = session;
  const roomId = await roomWithAlice(engine);
  await engine.asBob.setPowerLevels(roomId, { invite: 50 });
  await engine.asBob.setPowerLevel(roomId, engine.alice, myPower);
  if (targetMembership === 'knock') {
    await engine.asCarol.knock(roomId);
  } else if (targetMembership === 'ban') {
    await engine.asBob.ban(roomId, engine.carol, 'spam');
  } else {
    await engine.asBob.invite(roomId, engine.carol);
    if (targetMembership !== 'invite') await engine.asCarol.join(roomId);
    if (targetMembership === 'leave') await engine.asCarol.leave(roomId);
  }
  if (targetPower) {
    await engine.asBob.setPowerLevel(roomId, engine.carol, targetPower);
  }
  TestBed.configureTestingModule({ providers: session.providers });
  const projectionState = TestBed.inject(RoomAdministrationProjectionState);
  const select = (accountId: string | null): void => {
    projectionState.select(accountId, roomId);
    projectionState.update('permissions', 'available', 'retained');
  };
  select(engine.alice);
  return {
    ...session,
    roomId,
    target: engine.carol,
    key: { accountId: engine.alice, roomId },
    service: TestBed.inject(RoomActionPermissionsService),
    projectionState,
    /** Bob, at power 0, signs in beside alice and becomes the active account. */
    activateBob: async (): Promise<void> => {
      await engine.asBob.setPowerLevel(roomId, engine.bob, 0);
      engine.setLive(engine.bob, true);
      session.signIn([engine.alice, engine.bob], { active: engine.bob });
      select(engine.bob);
    },
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('RoomActionPermissionsService', () => {
  it('reads exact-account permissions independently of the active account', async () => {
    const { service, roomId, key, engine, activateBob } = await setup({
      myPower: 100,
    });

    await activateBob();

    expect(service.room(roomId).curateSpace.available).toBe(false);
    expect(service.roomFor(key).curateSpace.available).toBe(true);
    expect(service.settingsFor(key).name.available).toBe(true);
    expect(
      service.settingsFor({ accountId: engine.bob, roomId }).name.available,
    ).toBe(false);
  });

  it('keeps exact member, role and unban authority on the opening account', async () => {
    const { service, roomId, key, target, engine, activateBob } = await setup({
      myPower: 100,
    });

    await activateBob();

    expect(service.member(key, target).kick.available).toBe(true);
    expect(service.role(key, target, 50).available).toBe(true);
    await engine.asBob.ban(roomId, target, 'spam');
    expect(service.unban(key, target).available).toBe(true);
    expect(service.unban(roomId, target).available).toBe(false);
  });

  it('requires a joined actor and the effective invite/state thresholds', async () => {
    const { service, roomId, engine } = await setup({ myPower: 49 });

    expect(service.room(roomId)).toMatchObject({
      invite: { available: false },
      curateSpace: { available: false },
    });

    await engine.asBob.setPowerLevel(roomId, engine.alice, 50);
    expect(service.room(roomId)).toEqual({
      invite: { available: true, reason: null },
      curateSpace: { available: true, reason: null },
    });

    await engine.asBob.ban(roomId, engine.alice, 'gone');
    expect(service.room(roomId).invite.reason).toContain('Join this room');
  });

  it('projects every settings field from the live state-event threshold', async () => {
    const { service, roomId, engine } = await setup({ myPower: 49 });

    expect(Object.values(service.settings(roomId))).toHaveLength(11);
    expect(service.settings(roomId).permissions.reason).toBe(
      "Your role cannot change this room's permissions.",
    );
    expect(
      Object.values(service.settings(roomId)).every(
        (permission) => !permission.available && !!permission.reason,
      ),
    ).toBe(true);

    await engine.asBob.setPowerLevel(roomId, engine.alice, 50);
    expect(
      Object.values(service.settings(roomId)).every(
        (permission) => permission.available && permission.reason === null,
      ),
    ).toBe(true);
  });

  it.each([
    {
      type: 'm.room.tombstone',
      field: 'upgrade',
      reason: "Your role cannot change this room's version.",
    },
    {
      type: 'm.room.encryption',
      field: 'encryption',
      reason:
        'Only people who can change room settings can turn on encryption.',
    },
    {
      type: 'm.room.canonical_alias',
      field: 'directory',
      reason: "Your role cannot change this room's directory listing.",
    },
    {
      type: 'm.room.image_pack',
      field: 'imagePack',
      reason: "Your role cannot change this room's emoji.",
    },
  ] as const)(
    'allows $field only to members who may send $type',
    async ({ type, field, reason }) => {
      const { service, roomId, key, engine } = await setup({ myPower: 50 });
      await engine.asBob.setPowerLevels(roomId, { events: { [type]: 100 } });

      expect(service.settings(roomId).name.available).toBe(true);
      expect(service.settings(roomId)[field]).toEqual({
        available: false,
        reason,
      });

      await engine.asBob.setPowerLevel(roomId, engine.alice, 100);
      expect(service.settingsFor(key)[field]).toEqual({
        available: true,
        reason: null,
      });
    },
  );

  it.each([
    { myPower: 49, targetPower: 0, kick: false, ban: false, setPower: false },
    { myPower: 50, targetPower: 50, kick: false, ban: false, setPower: false },
    { myPower: 50, targetPower: 49, kick: true, ban: true, setPower: true },
  ])(
    'applies thresholds and strict rank for member actions ($myPower over $targetPower)',
    async ({ myPower, targetPower, kick, ban, setPower }) => {
      const { service, roomId, target } = await setup({
        myPower,
        targetPower,
      });

      expect(service.member(roomId, target)).toMatchObject({
        kick: { available: kick },
        ban: { available: ban },
        setPower: { available: setPower },
        myPower,
        targetPower,
      });
    },
  );

  it('never lets one v12 creator manage another', async () => {
    const session = administrationSession();
    const { engine } = session;
    const roomId = await roomWithAlice(engine, {
      roomVersion: '12',
      additionalCreators: [engine.alice, engine.carol],
    });
    await engine.asBob.invite(roomId, engine.carol);
    await engine.asCarol.join(roomId);
    TestBed.configureTestingModule({ providers: session.providers });
    const service = TestBed.inject(RoomActionPermissionsService);

    expect(
      service.member({ accountId: engine.alice, roomId }, engine.carol),
    ).toMatchObject({
      kick: { available: false },
      ban: { available: false },
      setPower: { available: false },
      myPower: Infinity,
      targetPower: Infinity,
    });
  });

  it('only assigns roles at or below the actor and never targets self', async () => {
    const { service, roomId, target, engine } = await setup({
      myPower: 50,
      targetPower: 0,
    });

    expect(service.role(roomId, target, 50).available).toBe(true);
    expect(service.role(roomId, target, 51).reason).toContain('above your own');
    expect(service.member(roomId, engine.alice).kick.available).toBe(false);
  });

  it.each(['invite', 'knock'] as const)(
    'lets a higher-ranked moderator remove someone whose membership is %s',
    async (targetMembership) => {
      const { service, roomId, target, engine } = await setup({
        targetMembership,
      });

      expect(service.member(roomId, target).kick.available).toBe(true);
      await engine.asBob.setPowerLevel(roomId, target, 50);
      expect(service.member(roomId, target).kick.reason).toContain(
        'lower role',
      );
      await engine.asBob.setPowerLevel(roomId, target, 0);
      await engine.asBob.setPowerLevels(roomId, { kick: 60 });
      expect(service.member(roomId, target).kick.available).toBe(false);
    },
  );

  it('still refuses to remove someone who has left', async () => {
    const { service, roomId, target } = await setup({
      targetMembership: 'leave',
    });

    expect(service.member(roomId, target).kick.reason).toContain(
      'no longer in the room',
    );
  });

  it('requires ban and kick thresholds plus strict rank to unban', async () => {
    const { service, roomId, target, engine } = await setup({
      myPower: 50,
      targetMembership: 'ban',
    });

    expect(service.unban(roomId, target).available).toBe(true);
    await engine.asBob.setPowerLevels(roomId, { kick: 60 });
    expect(service.unban(roomId, target).available).toBe(false);
    await engine.asBob.setPowerLevels(roomId, { kick: 50 });
    await engine.asBob.setPowerLevel(roomId, target, 50);
    expect(service.unban(roomId, target).reason).toContain('lower role');
  });

  it('updates consumers after remote threshold and membership changes', async () => {
    const { service, roomId, engine } = await setup({ myPower: 50 });
    const canInvite = computed(() => service.room(roomId).invite.available);
    expect(canInvite()).toBe(true);

    await engine.asBob.setPowerLevels(roomId, { invite: 60 });
    expect(canInvite()).toBe(false);

    await engine.asBob.setPowerLevels(roomId, { invite: 50 });
    expect(canInvite()).toBe(true);
    await engine.asBob.ban(roomId, engine.alice, 'gone');
    expect(canInvite()).toBe(false);
  });

  it('follows an account switch and sign-out at once', async () => {
    const { service, roomId, signIn, projectionState, activateBob } =
      await setup({ myPower: 50 });
    const canInvite = computed(() => service.room(roomId).invite.available);
    expect(canInvite()).toBe(true);

    await activateBob();
    expect(canInvite()).toBe(false);

    signIn([]);
    projectionState.release();
    expect(service.room(roomId).invite.available).toBe(false);
  });

  it('keeps the action-permissions lease for the active account', async () => {
    const { service } = await setup();
    const runtime = TestBed.inject(ProjectionRuntime);
    const subscription = service.runProjection().subscribe();

    await expect(
      firstValueFrom(
        runtime
          .observe('room-administration.action-permissions', {
            kind: 'active-account',
          })
          .pipe(filter((state) => state.condition === 'available')),
      ),
    ).resolves.toMatchObject({ condition: 'available' });
    subscription.unsubscribe();
  });

  it('throws a typed error when a final mutation guard fails', async () => {
    const { service } = await setup();
    const availability = {
      available: false,
      reason: 'Your role cannot invite people to this room.',
    };

    expect(() => service.assert(availability)).toThrowError(
      RoomActionPermissionError,
    );
    expect(() =>
      service.assert({ available: true, reason: null }),
    ).not.toThrow();
  });

  it('blocks state-backed actions while current permission authority is unavailable', async () => {
    const { service, roomId, target, projectionState } = await setup();
    projectionState.update('permissions', 'failed', 'retained');

    expect(service.room(roomId).invite).toMatchObject({
      available: false,
      reason: expect.stringContaining('permissions are unavailable'),
    });
    expect(service.settings(roomId).topic.available).toBe(false);
    expect(service.settings(roomId).upgrade.available).toBe(false);
    expect(service.settings(roomId).encryption.available).toBe(false);
    expect(service.settings(roomId).directory.available).toBe(false);
    expect(service.settings(roomId).imagePack.available).toBe(false);
    expect(service.member(roomId, target).ban.available).toBe(false);
    expect(service.unban(roomId, target).available).toBe(false);
  });

  it('keeps an exact-account read with its own current authorization usable', async () => {
    const { service, key, projectionState } = await setup();
    projectionState.update('permissions', 'failed', 'retained');

    expect(service.roomFor(key).invite.available).toBe(true);
  });
});
