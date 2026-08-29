import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import { RoomAliasesService } from './room-aliases.service';

function setup(
  opts: {
    aliases?: string[];
    canonical?: string;
    maySend?: boolean;
    noRoom?: boolean;
    me?: string;
  } = {},
) {
  const createAlias = vi.fn().mockResolvedValue({});
  const deleteAlias = vi.fn().mockResolvedValue({});
  const sendStateEvent = vi.fn().mockResolvedValue({});
  const getLocalAliases = vi
    .fn()
    .mockResolvedValue({ aliases: opts.aliases ?? [] });
  const room = opts.noRoom
    ? null
    : {
        // The service reads room state via the live timeline (liveRoomState()),
        // which is what the SDK's deprecated `currentState` aliased.
        getLiveTimeline: () => ({
          getState: () => ({
            maySendStateEvent: () => opts.maySend ?? true,
            getStateEvents: (_type: string, _key: string) =>
              opts.canonical !== undefined
                ? { getContent: () => ({ alias: opts.canonical }) }
                : null,
          }),
        }),
      };
  const instance = {
    createAlias,
    deleteAlias,
    sendStateEvent,
    getLocalAliases,
    getRoom: () => room,
    getUserId: () => opts.me ?? '@me:hs.example',
  };
  TestBed.configureTestingModule({
    providers: [
      RoomAliasesService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: instance as never,
      }),
      MockProvider(RoomActionPermissionsService, {
        settings: () => {
          const permission = {
            available: opts.maySend ?? true,
            reason: opts.maySend === false ? 'Not allowed.' : null,
          };
          return {
            name: permission,
            topic: permission,
            avatar: permission,
            joinRule: permission,
            history: permission,
            aliases: permission,
          };
        },
        assert: (permission: { available: boolean }) => {
          if (!permission.available) throw new Error('Not allowed.');
        },
      }),
    ],
  });
  return {
    svc: TestBed.inject(RoomAliasesService),
    createAlias,
    deleteAlias,
    sendStateEvent,
    getLocalAliases,
  };
}

describe('RoomAliasesService', () => {
  it('serverName is the domain of the signed-in user id', () => {
    expect(setup({ me: '@me:matrix.org' }).svc.serverName()).toBe('matrix.org');
  });

  it('localAliases is cold and returns the directory aliases', async () => {
    const { svc, getLocalAliases } = setup({ aliases: ['#a:hs', '#b:hs'] });

    const action = svc.localAliases('!r:hs');
    expect(getLocalAliases).not.toHaveBeenCalled(); // cold

    expect(await firstValueFrom(action)).toEqual(['#a:hs', '#b:hs']);
    expect(getLocalAliases).toHaveBeenCalledWith('!r:hs');
  });

  it('addAlias is cold and creates the alias on subscribe', async () => {
    const { svc, createAlias } = setup();

    const action = svc.addAlias('!r:hs', '#new:hs');
    expect(createAlias).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(createAlias).toHaveBeenCalledWith('#new:hs', '!r:hs');
  });

  it('removeAlias is cold and deletes the alias on subscribe', async () => {
    const { svc, deleteAlias } = setup();

    await firstValueFrom(svc.removeAlias('!r:hs', '#old:hs'));
    expect(deleteAlias).toHaveBeenCalledWith('#old:hs');
  });

  it('rechecks live permission before mutating an alias', async () => {
    const { svc, createAlias } = setup({ maySend: false });

    await expect(
      firstValueFrom(svc.addAlias('!r:hs', '#new:hs')),
    ).rejects.toThrow('Not allowed');
    expect(createAlias).not.toHaveBeenCalled();
  });

  it('setCanonicalAlias writes m.room.canonical_alias', async () => {
    const { svc, sendStateEvent } = setup();

    await firstValueFrom(svc.setCanonicalAlias('!r:hs', '#main:hs'));
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      'm.room.canonical_alias',
      { alias: '#main:hs' },
      '',
    );
  });

  it('currentCanonical reads the canonical alias from state', () => {
    expect(setup({ canonical: '#main:hs' }).svc.currentCanonical('!r:hs')).toBe(
      '#main:hs',
    );
  });

  it('currentCanonical is null when no canonical alias is set', () => {
    expect(setup().svc.currentCanonical('!r:hs')).toBeNull();
  });

  it('canManageAliases follows the canonical-alias send permission', () => {
    expect(setup({ maySend: true }).svc.canManageAliases('!r:hs')).toBe(true);
  });

  it('canManageAliases is false without the permission', () => {
    expect(setup({ maySend: false }).svc.canManageAliases('!r:hs')).toBe(false);
  });
});
