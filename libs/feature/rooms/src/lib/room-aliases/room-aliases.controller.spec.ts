import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomAliasesController } from './room-aliases.controller';

/**
 * The real RoomAliasesService and RoomActionPermissionsService run over a fake Matrix
 * client: only the homeserver boundary (`createAlias`, `deleteAlias`, `sendStateEvent`,
 * `getLocalAliases`, room state) is faked.
 */
function setup(opts: { aliases?: string[]; maySend?: boolean } = {}) {
  const maySend = signal(opts.maySend ?? true);
  const client = {
    getUserId: () => '@me:hs.example',
    getLocalAliases: vi.fn(() =>
      Promise.resolve({ aliases: opts.aliases ?? [] }),
    ),
    createAlias: vi.fn(() => Promise.resolve({})),
    deleteAlias: vi.fn(() => Promise.resolve({})),
    sendStateEvent: vi.fn(() => Promise.resolve({})),
    getRoom: () => ({
      getMyMembership: () => 'join',
      getMember: () => ({ powerLevel: 100 }),
      getLiveTimeline: () => ({
        getState: () => ({
          maySendStateEvent: () => maySend(),
          getStateEvents: () => null,
        }),
      }),
    }),
  };
  const toast = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      RoomAliasesController,
      MockProvider(MatrixClientService, {
        clientFor: (() => client) as never,
        activeUserId: signal<string | null>(null) as never,
      }),
      MockProvider(TrnAlertService, { confirm$: () => of(true) }),
      MockProvider(TrnToastService, { show: toast }),
    ],
  });
  const source = {
    accountId: signal('@me:hs.example'),
    roomId: signal('!r:hs'),
    noun: signal<'Room' | 'Space'>('Room'),
    available: signal(true),
  };
  const controller = TestBed.inject(RoomAliasesController);
  controller.connect(source);
  return { controller, client, toast, source, maySend };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('RoomAliasesController', () => {
  it('loads the directory and builds the address from the account server', async () => {
    const { controller } = setup({ aliases: ['#a:hs.example'] });

    controller.load();
    await settle();

    expect(controller.aliases()).toEqual(['#a:hs.example']);
    expect(controller.loading()).toBe(false);
    expect(controller.serverName()).toBe('hs.example');
  });

  it('adds an alias through the homeserver and lists it', async () => {
    const { controller, client } = setup();
    controller.aliasForm.localpart().value.set(' #team ');

    controller.add();
    await settle();

    expect(client.createAlias).toHaveBeenCalledWith(
      '#team:hs.example',
      '!r:hs',
    );
    expect(controller.aliases()).toEqual(['#team:hs.example']);
    expect(controller.aliasForm.localpart().value()).toBe('');
  });

  it('refuses to add or remove once authority is revoked', async () => {
    const { controller, client, maySend } = setup({
      aliases: ['#a:hs.example'],
    });
    controller.load();
    await settle();
    maySend.set(false);
    controller.aliasForm.localpart().value.set('x');

    controller.add();
    controller.remove('#a:hs.example');
    await settle();

    expect(client.createAlias).not.toHaveBeenCalled();
    expect(client.deleteAlias).not.toHaveBeenCalled();
  });

  it('removes a confirmed alias and sets another as primary', async () => {
    const { controller, client } = setup({
      aliases: ['#a:hs.example', '#b:hs.example'],
    });
    controller.load();
    await settle();

    controller.setPrimary('#a:hs.example');
    await settle();
    expect(controller.canonical()).toBe('#a:hs.example');

    controller.remove('#a:hs.example');
    await settle();

    expect(client.deleteAlias).toHaveBeenCalledWith('#a:hs.example');
    expect(controller.aliases()).toEqual(['#b:hs.example']);
    expect(controller.canonical()).toBeNull();
  });

  it('drops a late load that belongs to a previous target', async () => {
    const { controller, source } = setup({ aliases: ['#a:hs.example'] });
    controller.load();
    source.roomId.set('!other:hs');
    controller.switchTarget();
    await settle();

    expect(controller.aliases()).toEqual([]);
  });
});
