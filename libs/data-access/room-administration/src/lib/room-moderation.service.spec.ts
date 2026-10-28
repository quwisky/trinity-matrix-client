import { TestBed } from '@angular/core/testing';
import { engineFail, engineOk } from '@trinity/util/matrix';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeRoomAdministrationEngine } from '../contract/fake-room-administration-engine';
import { RoomAdministrationError } from './room-administration-error';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import {
  administrationSession,
  roomWithAlice,
} from './room-administration.spec-harness';
import { RoomModerationService } from './room-moderation.service';

const OTHER = '@other:example.org';

/** Alice at `alicePower` and carol (joined unless `carol` says otherwise) in bob's room. */
async function setup({
  alicePower = 100,
  carolPower = 0,
  carol = 'join',
}: {
  alicePower?: number;
  carolPower?: number;
  carol?: 'join' | 'invite' | 'knock' | 'ban';
} = {}) {
  const session = administrationSession(['@alice:example.org', OTHER]);
  const { engine } = session;
  const roomId = await roomWithAlice(engine);
  await engine.asBob.setPowerLevel(roomId, engine.alice, alicePower);
  await engine.asBob.setPowerLevel(roomId, engine.carol, carolPower);
  if (carol === 'knock') {
    await engine.asCarol.knock(roomId);
  } else {
    await engine.asBob.invite(roomId, engine.carol);
    if (carol !== 'invite') await engine.asCarol.join(roomId);
    if (carol === 'ban') await engine.asBob.ban(roomId, engine.carol, 'x');
  }
  TestBed.configureTestingModule({ providers: session.providers });
  const state = TestBed.inject(RoomAdministrationProjectionState);
  state.select(engine.alice, roomId);
  state.update('permissions', 'available', 'retained');
  return {
    ...session,
    roomId,
    target: { accountId: engine.alice, roomId },
    svc: TestBed.inject(RoomModerationService),
  };
}

function membershipOf(
  engine: FakeRoomAdministrationEngine,
  roomId: string,
  userId: string,
) {
  let member: { membership: string; reason: string | null } | undefined;
  engine
    .members(engine.alice, roomId)
    .subscribe((members) => {
      member = members?.members.find((m) => m.userId === userId);
    })
    .unsubscribe();
  return member && { membership: member.membership, reason: member.reason };
}

const failure = (action: Promise<unknown>) =>
  action.then(
    () => null,
    (error: unknown) => error,
  );

afterEach(() => TestBed.resetTestingModule());

describe('RoomModerationService', () => {
  it('kick is cold and removes the member with the reason on subscribe', async () => {
    const { svc, engine, roomId } = await setup();

    const action = svc.kick(roomId, engine.carol, 'spam');
    expect(membershipOf(engine, roomId, engine.carol)?.membership).toBe('join');

    await firstValueFrom(action);
    expect(membershipOf(engine, roomId, engine.carol)).toEqual({
      membership: 'leave',
      reason: 'spam',
    });
  });

  it.each(['invite', 'knock'] as const)(
    'kicks a target whose membership is %s',
    async (carol) => {
      const { svc, engine, roomId } = await setup({ carol });

      await firstValueFrom(svc.kick(roomId, engine.carol, 'no'));
      expect(membershipOf(engine, roomId, engine.carol)?.membership).toBe(
        'leave',
      );
    },
  );

  it('keeps an exact command on the opening Account while another is active', async () => {
    const { svc, engine, signIn, target } = await setup();
    signIn([engine.alice, OTHER], { active: OTHER });
    const kick = vi.spyOn(engine, 'kick');

    await firstValueFrom(svc.kick(target, engine.carol, 'spam'));

    expect(kick).toHaveBeenCalledExactlyOnceWith(
      engine.alice,
      target.roomId,
      engine.carol,
      'spam',
    );
  });

  it('a bare room ID acts as the active account', async () => {
    const { svc, engine, signIn, roomId } = await setup();
    signIn([engine.alice, OTHER], { active: OTHER });

    const error = await failure(
      firstValueFrom(svc.reportMessage(roomId, '$evt', '')),
    );

    // The other account knows no such room, so its server refuses.
    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'server-rejected',
    );
  });

  it('ban is cold and bans the member on subscribe, without a reason', async () => {
    const { svc, engine, roomId } = await setup();
    const ban = vi.spyOn(engine, 'ban');

    const action = svc.ban(roomId, engine.carol);
    expect(ban).not.toHaveBeenCalled();

    await firstValueFrom(action);
    expect(ban).toHaveBeenCalledWith(engine.alice, roomId, engine.carol, null);
    expect(membershipOf(engine, roomId, engine.carol)).toEqual({
      membership: 'ban',
      reason: null,
    });
  });

  it('unban is cold and lifts the ban on subscribe', async () => {
    const { svc, engine, roomId } = await setup({ carol: 'ban' });

    const action = svc.unban(roomId, engine.carol);
    expect(membershipOf(engine, roomId, engine.carol)?.membership).toBe('ban');

    await firstValueFrom(action);
    expect(membershipOf(engine, roomId, engine.carol)?.membership).toBe(
      'leave',
    );
  });

  it('setPowerLevel is cold and changes only that member, keeping other keys', async () => {
    const { svc, engine, roomId } = await setup();
    await engine.asBob.setPowerLevels(roomId, { 'org.example.custom': [1] });
    const setState = vi.spyOn(engine, 'setState');

    const action = svc.setPowerLevel(roomId, engine.carol, 50);
    expect(setState).not.toHaveBeenCalled();
    await firstValueFrom(action);

    const content = setState.mock.calls[0][4];
    expect(content['org.example.custom']).toEqual([1]);
    expect(content['users']).toEqual({
      [engine.bob]: 100,
      [engine.alice]: 100,
      [engine.carol]: 50,
    });
  });

  it('setPowerLevel without local power levels keeps everything the server has', async () => {
    const { svc, engine, roomId } = await setup();
    await engine.asBob.setPowerLevels(roomId, { 'org.example.custom': [1] });
    engine.withholdFromSnapshot(roomId, 'm.room.power_levels');
    const server = await firstValueFrom(
      engine.stateEvent(engine.alice, roomId, 'm.room.power_levels', ''),
    );
    const setState = vi.spyOn(engine, 'setState');

    await firstValueFrom(svc.setPowerLevel(roomId, engine.carol, 50));

    expect(setState.mock.calls[0][4]).toEqual({
      ...(server.ok ? server.value : {}),
      users: {
        [engine.bob]: 100,
        [engine.alice]: 100,
        [engine.carol]: 50,
      },
    });
  });

  it('setPowerLevel starts from empty power levels only when the server has none', async () => {
    const { svc, engine, roomId } = await setup();
    engine.withholdFromSnapshot(roomId, 'm.room.power_levels');
    vi.spyOn(engine, 'stateEvent').mockReturnValue(of(engineOk(null)));
    const setState = vi.spyOn(engine, 'setState');

    await firstValueFrom(svc.setPowerLevel(roomId, engine.carol, 50));

    expect(setState.mock.calls[0][4]).toEqual({
      users: { [engine.carol]: 50 },
    });
  });

  it('setPowerLevel sends nothing when the server copy cannot be read', async () => {
    const { svc, engine, roomId } = await setup();
    engine.withholdFromSnapshot(roomId, 'm.room.power_levels');
    vi.spyOn(engine, 'stateEvent').mockReturnValue(
      of(
        engineFail({
          kind: 'server',
          code: 'request-failed',
          diagnostic: { kind: 'server', httpStatus: 500, errcode: 'M_UNKNOWN' },
        }),
      ),
    );
    const setState = vi.spyOn(engine, 'setState');

    const error = await failure(
      firstValueFrom(svc.setPowerLevel(roomId, engine.carol, 50)),
    );

    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'server-rejected',
      operation: 'set-power-level',
    });
    expect(setState).not.toHaveBeenCalled();
  });

  it('reportMessage is cold and reports the event as the named account', async () => {
    const { svc, engine, target } = await setup();
    const eventId = await engine.asBob.sendMessage(target.roomId, 'bad');
    const reportEvent = vi.spyOn(engine, 'reportEvent');

    const action = svc.reportMessage(target, eventId, 'spam');
    expect(reportEvent).not.toHaveBeenCalled();
    await firstValueFrom(action);

    expect(reportEvent).toHaveBeenCalledExactlyOnceWith(
      engine.alice,
      target.roomId,
      eventId,
      'spam',
    );
  });

  it('reportMessage refuses an account that is no longer signed in', async () => {
    const { svc, engine, roomId } = await setup();
    const reportEvent = vi.spyOn(engine, 'reportEvent');

    const error = await failure(
      firstValueFrom(
        svc.reportMessage({ accountId: '@gone:hs', roomId }, '$evt', ''),
      ),
    );

    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'not-signed-in',
    );
    expect(reportEvent).not.toHaveBeenCalled();
  });

  it('a server refusal is retryable and carries no server text', async () => {
    const { svc, target } = await setup();

    const error = await failure(
      firstValueFrom(svc.reportMessage(target, '$unknown', '')),
    );

    expect(error).toBeInstanceOf(RoomAdministrationError);
    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'server-rejected',
      recovery: 'retry-operation',
      operation: 'report-message',
    });
    expect((error as Error).message).toBe('Something went wrong. Try again.');
  });

  it('refuses a kick without the power before sending', async () => {
    const { svc, engine, roomId } = await setup({ alicePower: 0 });
    const kick = vi.spyOn(engine, 'kick');

    const error = await failure(firstValueFrom(svc.kick(roomId, engine.carol)));

    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'permission-denied',
    );
    expect(kick).not.toHaveBeenCalled();
  });

  it('canModerate lets an admin kick/ban/set-power over a lower-power member', async () => {
    const { svc, engine, roomId } = await setup();
    expect(svc.canModerate(roomId, engine.carol)).toEqual({
      kick: true,
      ban: true,
      setPower: true,
      myPower: 100,
    });
  });

  it('canModerate denies a member who cannot out-rank the target', async () => {
    const { svc, engine, roomId } = await setup({ alicePower: 0 });
    expect(svc.canModerate(roomId, engine.carol)).toEqual({
      kick: false,
      ban: false,
      setPower: false,
      myPower: 0,
    });
  });

  it('canModerate requires strictly out-ranking (equal power denied)', async () => {
    const { svc, engine, roomId } = await setup({
      alicePower: 50,
      carolPower: 50,
    });
    expect(svc.canModerate(roomId, engine.carol)).toEqual({
      kick: false,
      ban: false,
      setPower: false,
      myPower: 50,
    });
  });

  it('canModerate reflects per-action power (kick yes, ban no) and reports myPower', async () => {
    const { svc, engine, roomId } = await setup({ alicePower: 60 });
    await engine.asBob.setPowerLevels(roomId, { ban: 100 });
    expect(svc.canModerate(roomId, engine.carol)).toEqual({
      kick: true,
      ban: false,
      setPower: true,
      myPower: 60,
    });
  });

  it('canModerate denies setPower when the power-levels event is not sendable', async () => {
    const { svc, engine, roomId } = await setup({ alicePower: 60 });
    await engine.asBob.setPowerLevels(roomId, {
      events: { 'm.room.power_levels': 100 },
    });
    expect(svc.canModerate(roomId, engine.carol)).toMatchObject({
      kick: true,
      ban: true,
      setPower: false,
    });
  });

  it('canModerate never targets yourself', async () => {
    const { svc, engine, roomId } = await setup();
    expect(svc.canModerate(roomId, engine.alice)).toEqual({
      kick: false,
      ban: false,
      setPower: false,
      myPower: 100,
    });
  });
});
