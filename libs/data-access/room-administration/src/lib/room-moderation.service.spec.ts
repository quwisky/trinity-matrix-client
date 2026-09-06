import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomModerationService } from './room-moderation.service';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';

function setup(
  opts: {
    myLevel?: number;
    targetLevel?: number;
    may?: (action: string) => boolean;
    maySetPower?: boolean;
    me?: string;
    kickError?: Error;
    banError?: Error;
    targetMembership?: string;
  } = {},
) {
  const kick = opts.kickError
    ? vi.fn().mockRejectedValue(opts.kickError)
    : vi.fn().mockResolvedValue({});
  const ban = opts.banError
    ? vi.fn().mockRejectedValue(opts.banError)
    : vi.fn().mockResolvedValue({});
  const unban = vi.fn().mockResolvedValue({});
  const setPowerLevel = vi.fn().mockResolvedValue({});
  const reportEvent = vi.fn().mockResolvedValue({});
  const me = opts.me ?? '@me:hs';
  const myLevel = opts.myLevel ?? 100;
  const targetLevel = opts.targetLevel ?? 0;
  const room = {
    getMember: (id: string) => ({
      powerLevel: id === me ? myLevel : targetLevel,
      membership: id === me ? 'join' : (opts.targetMembership ?? 'join'),
    }),
    getMyMembership: () => 'join',
    // The service reads room state via the live timeline (liveRoomState()),
    // which is what the SDK's deprecated `currentState` aliased.
    getLiveTimeline: () => ({
      getState: () => ({
        hasSufficientPowerLevelFor: (action: string, level: number) =>
          opts.may ? opts.may(action) : level >= 50,
        maySendStateEvent: () => opts.maySetPower ?? true,
      }),
    }),
  };
  const instance = {
    kick,
    ban,
    unban,
    setPowerLevel,
    reportEvent,
    getRoom: () => room,
    getUserId: () => me,
  };
  TestBed.configureTestingModule({
    providers: [
      RoomModerationService,
      MockProvider(MatrixClientService, {
        activeUserId: signal<string | null>(me).asReadonly(),
        isInitialized: true,
        instance: instance as never,
        clientFor: (accountId: string) =>
          accountId === me ? (instance as never) : null,
      }),
    ],
  });
  const projectionState = TestBed.inject(RoomAdministrationProjectionState);
  projectionState.select(me, '!r:hs');
  projectionState.update('permissions', 'available', 'retained');
  return {
    svc: TestBed.inject(RoomModerationService),
    matrix: TestBed.inject(MatrixClientService),
    kick,
    ban,
    unban,
    setPowerLevel,
    reportEvent,
  };
}

describe('RoomModerationService', () => {
  it('kick is cold and sends the reason on subscribe', async () => {
    const { svc, kick } = setup();

    const action = svc.kick('!r:hs', '@bob:hs', 'spam');
    expect(kick).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(kick).toHaveBeenCalledWith('!r:hs', '@bob:hs', 'spam');
  });

  it('keeps an exact command on the opening Account after the active client changes', async () => {
    const { svc, matrix, kick } = setup();
    const otherKick = vi.fn().mockResolvedValue({});
    ngMocks.stubMember(matrix, 'instance', {
      kick: otherKick,
    } as never);

    await firstValueFrom(
      svc.kick(
        { accountId: '@me:hs', roomId: '!same-id:hs' },
        '@bob:hs',
        'spam',
      ),
    );

    expect(kick).toHaveBeenCalledWith('!same-id:hs', '@bob:hs', 'spam');
    expect(otherKick).not.toHaveBeenCalled();
  });

  it('ban is cold and bans the member on subscribe', async () => {
    const { svc, ban } = setup();

    await firstValueFrom(svc.ban('!r:hs', '@bob:hs'));
    expect(ban).toHaveBeenCalledWith('!r:hs', '@bob:hs', undefined);
  });

  it('unban is cold and lifts the ban on subscribe', async () => {
    const { svc, unban } = setup({ targetMembership: 'ban' });

    const action = svc.unban('!r:hs', '@bob:hs');
    expect(unban).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(unban).toHaveBeenCalledWith('!r:hs', '@bob:hs');
  });

  it('setPowerLevel is cold and promotes/demotes on subscribe', async () => {
    const { svc, setPowerLevel } = setup();

    const action = svc.setPowerLevel('!r:hs', '@bob:hs', 50);
    expect(setPowerLevel).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(setPowerLevel).toHaveBeenCalledWith('!r:hs', '@bob:hs', 50);
  });

  it('reportMessage is cold and reports the event with a reason on subscribe', async () => {
    const { svc, reportEvent } = setup();

    const action = svc.reportMessage('!r:hs', '$evt', 'spam');
    expect(reportEvent).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(reportEvent).toHaveBeenCalledWith('!r:hs', '$evt', -100, 'spam');
  });

  it('canModerate lets an admin kick/ban/set-power over a lower-power member', () => {
    const { svc } = setup({ myLevel: 100, targetLevel: 0 });
    expect(svc.canModerate('!r:hs', '@bob:hs')).toEqual({
      kick: true,
      ban: true,
      setPower: true,
      myPower: 100,
    });
  });

  it('canModerate denies a member who cannot out-rank the target', () => {
    const { svc } = setup({ myLevel: 0, targetLevel: 0 });
    expect(svc.canModerate('!r:hs', '@bob:hs')).toEqual({
      kick: false,
      ban: false,
      setPower: false,
      myPower: 0,
    });
  });

  it('canModerate requires strictly out-ranking (equal power denied)', () => {
    const { svc } = setup({ myLevel: 50, targetLevel: 50 });
    expect(svc.canModerate('!r:hs', '@bob:hs')).toEqual({
      kick: false,
      ban: false,
      setPower: false,
      myPower: 50,
    });
  });

  it('canModerate reflects per-action power (kick yes, ban no) and reports myPower', () => {
    const { svc } = setup({
      myLevel: 60,
      targetLevel: 0,
      may: (action) => action === 'kick',
    });
    expect(svc.canModerate('!r:hs', '@bob:hs')).toEqual({
      kick: true,
      ban: false,
      setPower: true,
      myPower: 60,
    });
  });

  it('canModerate denies setPower when the power-levels event is not sendable', () => {
    const { svc } = setup({ myLevel: 100, targetLevel: 0, maySetPower: false });
    expect(svc.canModerate('!r:hs', '@bob:hs')).toMatchObject({
      kick: true,
      ban: true,
      setPower: false,
    });
  });

  it('canModerate never targets yourself', () => {
    const { svc } = setup({ myLevel: 100 });
    expect(svc.canModerate('!r:hs', '@me:hs')).toEqual({
      kick: false,
      ban: false,
      setPower: false,
      myPower: 100,
    });
  });
});
