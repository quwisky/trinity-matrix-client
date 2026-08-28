import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomModerationService } from './room-moderation.service';
import { RoomsService } from './rooms.service';

interface FakeBan {
  userId: string;
  name: string;
  reason?: string;
}

function setup(
  opts: {
    myLevel?: number;
    targetLevel?: number;
    may?: (action: string) => boolean;
    maySetPower?: boolean;
    me?: string;
    noRoom?: boolean;
    bans?: FakeBan[];
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
  const removeMemberFromProjection = vi.fn();
  const me = opts.me ?? '@me:hs';
  const myLevel = opts.myLevel ?? 100;
  const targetLevel = opts.targetLevel ?? 0;
  const room = opts.noRoom
    ? null
    : {
        getMember: (id: string) => ({
          powerLevel: id === me ? myLevel : targetLevel,
          membership: id === me ? 'join' : (opts.targetMembership ?? 'join'),
        }),
        getMyMembership: () => 'join',
        getMembersWithMembership: (_membership: string) =>
          (opts.bans ?? []).map((b) => ({
            userId: b.userId,
            name: b.name,
            events: {
              member: { getContent: () => ({ reason: b.reason }) },
            },
          })),
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
        isInitialized: true,
        instance: instance as never,
      }),
      MockProvider(RoomsService, { removeMemberFromProjection }),
    ],
  });
  return {
    svc: TestBed.inject(RoomModerationService),
    matrix: TestBed.inject(MatrixClientService),
    kick,
    ban,
    unban,
    setPowerLevel,
    reportEvent,
    removeMemberFromProjection,
  };
}

describe('RoomModerationService', () => {
  it('kick is cold and removes the member (with reason) on subscribe', async () => {
    const { svc, kick, removeMemberFromProjection } = setup();

    const action = svc.kick('!r:hs', '@bob:hs', 'spam');
    expect(kick).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(kick).toHaveBeenCalledWith('!r:hs', '@bob:hs', 'spam');
    expect(removeMemberFromProjection).toHaveBeenCalledWith('!r:hs', '@bob:hs');
  });

  it('ban is cold and bans the member on subscribe', async () => {
    const { svc, ban, removeMemberFromProjection } = setup();

    await firstValueFrom(svc.ban('!r:hs', '@bob:hs'));
    expect(ban).toHaveBeenCalledWith('!r:hs', '@bob:hs', undefined);
    expect(removeMemberFromProjection).toHaveBeenCalledWith('!r:hs', '@bob:hs');
  });

  it('keeps the member projected when moderation fails', async () => {
    const { svc, removeMemberFromProjection } = setup({
      kickError: new Error('forbidden'),
    });

    await expect(firstValueFrom(svc.kick('!r:hs', '@bob:hs'))).rejects.toThrow(
      'forbidden',
    );
    expect(removeMemberFromProjection).not.toHaveBeenCalled();
  });

  it('does not project a late moderation result into a new account', async () => {
    let resolveKick!: () => void;
    const pendingKick = new Promise<void>((resolve) => {
      resolveKick = resolve;
    });
    const { svc, matrix, kick, removeMemberFromProjection } = setup();
    kick.mockReturnValueOnce(pendingKick);

    const result = firstValueFrom(svc.kick('!r:hs', '@bob:hs'));
    (matrix as unknown as { instance: object }).instance = {};
    resolveKick();
    await result;

    expect(removeMemberFromProjection).not.toHaveBeenCalled();
  });

  it('unban is cold and lifts the ban on subscribe', async () => {
    const { svc, unban } = setup({ targetMembership: 'ban' });

    const action = svc.unban('!r:hs', '@bob:hs');
    expect(unban).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(unban).toHaveBeenCalledWith('!r:hs', '@bob:hs');
  });

  it('bannedMembers lists banned members with reasons, sorted by name', () => {
    const { svc } = setup({
      bans: [
        { userId: '@zed:hs', name: 'Zed', reason: 'spam' },
        { userId: '@amy:hs', name: 'Amy' },
      ],
    });
    expect(svc.bannedMembers('!r:hs')).toEqual([
      { userId: '@amy:hs', name: 'Amy', reason: null },
      { userId: '@zed:hs', name: 'Zed', reason: 'spam' },
    ]);
  });

  it('bannedMembers is empty for an unknown room', () => {
    const { svc } = setup({ noRoom: true });
    expect(svc.bannedMembers('!r:hs')).toEqual([]);
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
