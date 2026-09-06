import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import { RoomAliasesService } from './room-aliases.service';

const TARGET = { accountId: '@me:hs', roomId: '!r:hs' } as const;

function setup(
  opts: {
    aliases?: string[];
    canonical?: string;
    canonicalContent?: Record<string, unknown>;
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
              opts.canonicalContent !== undefined ||
              opts.canonical !== undefined
                ? {
                    getContent: () =>
                      opts.canonicalContent ?? { alias: opts.canonical },
                  }
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
  const clientFor = vi.fn((accountId: string) =>
    accountId === TARGET.accountId ? instance : null,
  );
  const settingsFor = vi.fn(() => {
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
  });
  TestBed.configureTestingModule({
    providers: [
      RoomAliasesService,
      MockProvider(MatrixClientService, {
        clientFor: clientFor as never,
      }),
      MockProvider(RoomActionPermissionsService, {
        settingsFor,
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
    clientFor,
    settingsFor,
  };
}

describe('RoomAliasesService', () => {
  it('serverName is the domain of the signed-in user id', () => {
    expect(setup({ me: '@me:matrix.org' }).svc.serverName(TARGET)).toBe(
      'matrix.org',
    );
  });

  it('localAliases is cold and returns the directory aliases', async () => {
    const { svc, getLocalAliases, clientFor } = setup({
      aliases: ['#a:hs', '#b:hs'],
    });

    const action = svc.localAliases(TARGET);
    expect(getLocalAliases).not.toHaveBeenCalled(); // cold

    expect(await firstValueFrom(action)).toEqual(['#a:hs', '#b:hs']);
    expect(clientFor).toHaveBeenCalledWith(TARGET.accountId);
    expect(getLocalAliases).toHaveBeenCalledWith('!r:hs');
  });

  it('addAlias is cold and creates the alias on subscribe', async () => {
    const { svc, createAlias } = setup();

    const action = svc.addAlias(TARGET, '#new:hs');
    expect(createAlias).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(createAlias).toHaveBeenCalledWith('#new:hs', '!r:hs');
  });

  it('removeAlias is cold and deletes the alias on subscribe', async () => {
    const { svc, deleteAlias } = setup();

    await firstValueFrom(svc.removeAlias(TARGET, '#old:hs'));
    expect(deleteAlias).toHaveBeenCalledWith('#old:hs');
  });

  it('clears a primary address before removing it from the directory', async () => {
    const { svc, sendStateEvent, deleteAlias } = setup({
      canonicalContent: {
        alias: '#primary:hs',
        alt_aliases: ['#alternative:elsewhere'],
      },
    });

    await firstValueFrom(svc.removeAlias(TARGET, '#primary:hs'));

    expect(sendStateEvent).toHaveBeenCalledWith(
      TARGET.roomId,
      'm.room.canonical_alias',
      { alt_aliases: ['#alternative:elsewhere'] },
      '',
    );
    expect(sendStateEvent.mock.invocationCallOrder[0]).toBeLessThan(
      deleteAlias.mock.invocationCallOrder[0],
    );
  });

  it('rechecks live permission before mutating an alias', async () => {
    const { svc, createAlias, settingsFor } = setup({ maySend: false });

    await expect(
      firstValueFrom(svc.addAlias(TARGET, '#new:hs')),
    ).rejects.toThrow('Not allowed');
    expect(createAlias).not.toHaveBeenCalled();
    expect(settingsFor).toHaveBeenCalledWith(TARGET);
  });

  it('setCanonicalAlias writes m.room.canonical_alias', async () => {
    const { svc, sendStateEvent } = setup({
      canonicalContent: {
        alias: '#old:hs',
        alt_aliases: ['#alternative:elsewhere'],
      },
    });

    await firstValueFrom(svc.setCanonicalAlias(TARGET, '#main:hs'));
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      'm.room.canonical_alias',
      { alias: '#main:hs', alt_aliases: ['#alternative:elsewhere'] },
      '',
    );
  });

  it('currentCanonical reads the canonical alias from state', () => {
    expect(setup({ canonical: '#main:hs' }).svc.currentCanonical(TARGET)).toBe(
      '#main:hs',
    );
  });

  it('currentCanonical is null when no canonical alias is set', () => {
    expect(setup().svc.currentCanonical(TARGET)).toBeNull();
  });

  it('canManageAliases follows the canonical-alias send permission', () => {
    expect(setup({ maySend: true }).svc.canManageAliases(TARGET)).toBe(true);
  });

  it('canManageAliases is false without the permission', () => {
    expect(setup({ maySend: false }).svc.canManageAliases(TARGET)).toBe(false);
  });
});
