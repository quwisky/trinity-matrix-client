import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  MatrixClientService,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import { AdministeredRoomStore } from './administered-room.store';
import type { Membership } from './room-administration-engine';
import { RoomModerationService } from './room-moderation.service';
import { administeredRoom } from './room-administration.spec-harness';
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
  // Thresholds a level always or never meets stand in for per-action answers.
  const threshold = (allowed: boolean) => (allowed ? 0 : 1_000);
  const powerLevels = {
    ...(opts.may
      ? { kick: threshold(opts.may('kick')), ban: threshold(opts.may('ban')) }
      : { kick: 50, ban: 50 }),
    events: { 'm.room.power_levels': threshold(opts.maySetPower ?? true) },
  };
  const store: Pick<AdministeredRoomStore, 'room' | 'members'> = {
    room: (accountId, roomId) =>
      accountId === me
        ? administeredRoom(roomId, me, { ownPower: myLevel, powerLevels })
        : null,
    members: (accountId, roomId) =>
      accountId === me
        ? {
            roomId,
            complete: true,
            members: [
              { userId: me, power: myLevel, membership: 'join' as Membership },
              {
                userId: '@bob:hs',
                power: targetLevel,
                membership: (opts.targetMembership ?? 'join') as Membership,
              },
            ].map((member) => ({
              ...member,
              displayName: member.userId,
              avatarMxc: null,
              reason: null,
            })),
          }
        : null,
  };
  const instance = {
    kick,
    ban,
    unban,
    setPowerLevel,
    reportEvent,
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
      { provide: AdministeredRoomStore, useValue: store },
      MockProvider(SessionStateService, {
        activeAccountId: signal<string | null>(me).asReadonly(),
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

  it.each(['invite', 'knock'])(
    'kicks a target whose membership is %s',
    async (targetMembership) => {
      const { svc, kick } = setup({ targetMembership });

      await firstValueFrom(svc.kick('!r:hs', '@bob:hs', 'no'));
      expect(kick).toHaveBeenCalledWith('!r:hs', '@bob:hs', 'no');
    },
  );

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

  it('reportMessage reports as the named account, not the active one', async () => {
    const { svc, reportEvent } = setup();

    await firstValueFrom(
      svc.reportMessage(
        { accountId: '@me:hs', roomId: '!r:hs' },
        '$evt',
        'spam',
      ),
    );

    expect(reportEvent).toHaveBeenCalledWith('!r:hs', '$evt', -100, 'spam');
  });

  it('reportMessage refuses an account that is no longer signed in', async () => {
    const { svc, reportEvent } = setup();

    await expect(
      firstValueFrom(
        svc.reportMessage(
          { accountId: '@gone:hs', roomId: '!r:hs' },
          '$evt',
          '',
        ),
      ),
    ).rejects.toThrow();
    expect(reportEvent).not.toHaveBeenCalled();
  });
});
