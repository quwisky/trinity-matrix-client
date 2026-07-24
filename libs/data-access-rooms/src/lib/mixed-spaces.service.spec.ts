import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { MixedSpacesService } from './mixed-spaces.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

type Listener = (...args: unknown[]) => void;

function fakeSpace(
  id: string,
  opts: { name?: string; space?: boolean; membership?: string } = {},
) {
  return {
    roomId: id,
    name: opts.name ?? id,
    isSpaceRoom: () => opts.space ?? true,
    getMyMembership: () => opts.membership ?? 'join',
    getMxcAvatarUrl: () => null,
    // childRoomIds reads m.space.child off the live timeline state; these fakes have none.
    getLiveTimeline: () => ({ getState: () => undefined }),
  };
}

function fakeClient(rooms: ReturnType<typeof fakeSpace>[]) {
  const handlers = new Map<string, Set<Listener>>();
  return {
    getRooms: () => rooms,
    on(evt: string, handler: Listener) {
      (handlers.get(evt) ?? handlers.set(evt, new Set()).get(evt)!).add(
        handler,
      );
    },
    off(evt: string, handler: Listener) {
      handlers.get(evt)?.delete(handler);
    },
    listenerCount() {
      let total = 0;
      handlers.forEach((set) => (total += set.size));
      return total;
    },
  };
}

function harness(): {
  svc: MixedSpacesService;
  accountIds: WritableSignal<readonly string[]>;
  clients: Map<string, ReturnType<typeof fakeClient>>;
  flush: () => Promise<void>;
} {
  const accountIds = signal<readonly string[]>([]);
  const clients = new Map<string, ReturnType<typeof fakeClient>>();
  const matrix = {
    accountIds: accountIds.asReadonly(),
    clientFor: (id: string) => clients.get(id) ?? null,
  } as unknown as MatrixClientService;

  TestBed.configureTestingModule({
    providers: [
      MixedSpacesService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  const svc = TestBed.inject(MixedSpacesService);
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return { svc, accountIds, clients, flush };
}

describe('MixedSpacesService', () => {
  it('aggregates the selected accounts’ joined spaces, tagged with the account', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeSpace('!s1:hs', { name: 'Work' })]));
    clients.set(
      '@b:hs',
      fakeClient([
        fakeSpace('!s2:hs', { name: 'Personal' }),
        fakeSpace('!r:hs', { space: false }), // non-space excluded
      ]),
    );
    accountIds.set(['@a:hs', '@b:hs']);
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();

    // Sorted by name; each pill carries its owning account.
    expect(svc.spaces().map((s) => [s.id, s.accountId, s.name])).toEqual([
      ['!s2:hs', '@b:hs', 'Personal'],
      ['!s1:hs', '@a:hs', 'Work'],
    ]);
    // childRoomIds is read from each space's m.space.child links; these fakes have none.
    expect(svc.spaces()[0].childRoomIds).toEqual([]);
  });

  it('ignores signed-in accounts that are not selected', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeSpace('!s1:hs', { name: 'Work' })]));
    clients.set('@b:hs', fakeClient([fakeSpace('!s2:hs', { name: 'Home' })]));
    clients.set('@c:hs', fakeClient([fakeSpace('!s3:hs', { name: 'Other' })]));
    accountIds.set(['@a:hs', '@b:hs', '@c:hs']);
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();

    expect(
      svc
        .spaces()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['!s1:hs', '!s2:hs']);
    expect(clients.get('@c:hs')!.listenerCount()).toBe(0);
  });

  it('stays empty and attaches nothing until accounts are selected', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeSpace('!s:hs')]));
    accountIds.set(['@a:hs']);
    await flush();

    expect(svc.spaces()).toEqual([]);
    expect(clients.get('@a:hs')!.listenerCount()).toBe(0);
  });
});
