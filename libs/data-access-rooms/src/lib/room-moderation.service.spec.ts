import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { RoomModerationService } from './room-moderation.service';

function setup(
  opts: {
    myLevel?: number;
    targetLevel?: number;
    may?: (action: string) => boolean;
    me?: string;
    noRoom?: boolean;
  } = {},
) {
  const kick = vi.fn().mockResolvedValue({});
  const ban = vi.fn().mockResolvedValue({});
  const me = opts.me ?? '@me:hs';
  const myLevel = opts.myLevel ?? 100;
  const targetLevel = opts.targetLevel ?? 0;
  const room = opts.noRoom
    ? null
    : {
        getMember: (id: string) => ({
          powerLevel: id === me ? myLevel : targetLevel,
        }),
        currentState: {
          hasSufficientPowerLevelFor: (action: string, level: number) =>
            opts.may ? opts.may(action) : level >= 50,
        },
      };
  const instance = { kick, ban, getRoom: () => room, getUserId: () => me };
  TestBed.configureTestingModule({
    providers: [
      RoomModerationService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: instance as never,
      }),
    ],
  });
  return { svc: TestBed.inject(RoomModerationService), kick, ban };
}

describe('RoomModerationService', () => {
  it('kick is cold and removes the member (with reason) on subscribe', async () => {
    const { svc, kick } = setup();

    const action = svc.kick('!r:hs', '@bob:hs', 'spam');
    expect(kick).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(kick).toHaveBeenCalledWith('!r:hs', '@bob:hs', 'spam');
  });

  it('ban is cold and bans the member on subscribe', async () => {
    const { svc, ban } = setup();

    await firstValueFrom(svc.ban('!r:hs', '@bob:hs'));
    expect(ban).toHaveBeenCalledWith('!r:hs', '@bob:hs', undefined);
  });

  it('canModerate allows an admin to kick/ban a lower-power member', () => {
    const { svc } = setup({ myLevel: 100, targetLevel: 0 });
    expect(svc.canModerate('!r:hs', '@bob:hs')).toEqual({
      kick: true,
      ban: true,
    });
  });

  it('canModerate denies a member who cannot out-rank the target', () => {
    const { svc } = setup({ myLevel: 0, targetLevel: 0 });
    expect(svc.canModerate('!r:hs', '@bob:hs')).toEqual({
      kick: false,
      ban: false,
    });
  });

  it('canModerate requires strictly out-ranking (equal power denied)', () => {
    const { svc } = setup({ myLevel: 50, targetLevel: 50 });
    expect(svc.canModerate('!r:hs', '@bob:hs')).toEqual({
      kick: false,
      ban: false,
    });
  });

  it('canModerate reflects the per-action power requirement (kick yes, ban no)', () => {
    const { svc } = setup({
      myLevel: 60,
      targetLevel: 0,
      may: (action) => action === 'kick',
    });
    expect(svc.canModerate('!r:hs', '@bob:hs')).toEqual({
      kick: true,
      ban: false,
    });
  });

  it('canModerate never targets yourself', () => {
    const { svc } = setup({ myLevel: 100 });
    expect(svc.canModerate('!r:hs', '@me:hs')).toEqual({
      kick: false,
      ban: false,
    });
  });
});
