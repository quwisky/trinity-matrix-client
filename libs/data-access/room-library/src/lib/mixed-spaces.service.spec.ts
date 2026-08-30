import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { MixedSpacesService } from './mixed-spaces.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

type Listener = (...args: unknown[]) => void;

function fakeSpace(
  id: string,
  opts: {
    name?: string;
    space?: boolean;
    membership?: string;
    /** Child room ids linked via `m.space.child` state events. */
    children?: string[];
  } = {},
) {
  const children = opts.children ?? [];
  return {
    roomId: id,
    name: opts.name ?? id,
    isSpaceRoom: () => opts.space ?? true,
    getMyMembership: () => opts.membership ?? 'join',
    getMxcAvatarUrl: () => null,
    // childRoomIds reads m.space.child off the live timeline state.
    getLiveTimeline: () => ({
      getState: () => ({
        getStateEvents: (type: string) =>
          type === 'm.space.child'
            ? children.map((childId) => ({
                getStateKey: () => childId,
                getContent: () => ({ via: ['hs'] }),
              }))
            : [],
      }),
    }),
  };
}

function fakeClient(rooms: ReturnType<typeof fakeSpace>[]) {
  const handlers = new Map<string, Set<Listener>>();
  return {
    getRooms: () => rooms,
    // spaceChildIdsOf resolves each linked child and keeps only joined ones.
    getRoom: (id: string) => ({
      name: id,
      getMyMembership: () => 'join',
    }),
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
  activeUserId: WritableSignal<string | null>;
  clients: Map<string, ReturnType<typeof fakeClient>>;
  flush: () => Promise<void>;
} {
  const accountIds = signal<readonly string[]>([]);
  const clients = new Map<string, ReturnType<typeof fakeClient>>();
  const activeUserId = signal<string | null>(null);
  const matrix = {
    accountIds: accountIds.asReadonly(),
    activeUserId: activeUserId.asReadonly(),
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
  return { svc, accountIds, activeUserId, clients, flush };
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
    // childRoomIds is resolved from each space's own m.space.child links, on its own client.
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

  // Guards the Rooms view's cross-account space-child exclusion: without real child ids
  // every account's space-owned rooms leak back into the flat Rooms list.
  it('resolves each space’s joined children from its own account’s client', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set(
      '@a:hs',
      fakeClient([
        fakeSpace('!s1:hs', { name: 'Work', children: ['!c1:hs', '!c2:hs'] }),
      ]),
    );
    clients.set('@b:hs', fakeClient([fakeSpace('!s2:hs', { name: 'Home' })]));
    accountIds.set(['@a:hs', '@b:hs']);
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();

    const work = svc.spaces().find((s) => s.id === '!s1:hs');
    expect(work?.childRoomIds).toEqual(['!c1:hs', '!c2:hs']);
    expect(svc.spaces().find((s) => s.id === '!s2:hs')?.childRoomIds).toEqual(
      [],
    );
  });

  it('emits one pill when two accounts share a space, preferring the active account', async () => {
    const { svc, accountIds, activeUserId, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeSpace('!s:hs', { name: 'Shared' })]));
    clients.set('@b:hs', fakeClient([fakeSpace('!s:hs', { name: 'Shared' })]));
    accountIds.set(['@a:hs', '@b:hs']);
    activeUserId.set('@b:hs');
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();

    expect(svc.spaces().map((s) => s.id)).toEqual(['!s:hs']);
    expect(svc.spaces()[0].accountId).toBe('@b:hs');
  });

  // Each account's copy of a shared space lists only the children THAT account joined, so
  // keeping one copy would stop excluding the other's space-owned rooms from the flat Rooms
  // list — they would reappear there as top-level entries.
  it('unions the child ids of a space both accounts have joined', async () => {
    const { svc, accountIds, activeUserId, clients, flush } = harness();
    clients.set(
      '@a:hs',
      fakeClient([fakeSpace('!s:hs', { name: 'Shared', children: ['!x:hs'] })]),
    );
    clients.set(
      '@b:hs',
      fakeClient([
        fakeSpace('!s:hs', { name: 'Shared', children: ['!x:hs', '!y:hs'] }),
      ]),
    );
    accountIds.set(['@a:hs', '@b:hs']);
    activeUserId.set('@a:hs'); // @a's copy wins the pill, but not the child list
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();

    expect(svc.spaces().length).toBe(1);
    expect(svc.spaces()[0].accountId).toBe('@a:hs');
    expect([...svc.spaces()[0].childRoomIds].sort()).toEqual([
      '!x:hs',
      '!y:hs',
    ]);
  });

  it('re-attributes a shared space when the active account changes', async () => {
    const { svc, accountIds, activeUserId, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeSpace('!s:hs')]));
    clients.set('@b:hs', fakeClient([fakeSpace('!s:hs')]));
    accountIds.set(['@a:hs', '@b:hs']);
    activeUserId.set('@a:hs');
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();
    expect(svc.spaces()[0].accountId).toBe('@a:hs');

    // Switching accounts emits no client event; without an explicit re-flush the pill
    // would stay tagged @a and selecting it would switch straight back.
    activeUserId.set('@b:hs');
    TestBed.tick();
    await flush();
    expect(svc.spaces()[0].accountId).toBe('@b:hs');
  });

  it('stays empty and attaches nothing until accounts are selected', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeSpace('!s:hs')]));
    accountIds.set(['@a:hs']);
    await flush();

    expect(svc.spaces()).toEqual([]);
    expect(clients.get('@a:hs')!.listenerCount()).toBe(0);
  });

  it('coalesces a burst of events into one rebuild', async () => {
    const { svc, accountIds, clients, flush } = harness();
    const a = fakeClient([fakeSpace('!s1:hs', { name: 'Work' })]);
    const getRooms = vi.fn(() => a.getRooms());
    // This fake has no emit(), so capture the handler the service registers and call it.
    let fire: Listener | undefined;
    clients.set('@a:hs', {
      ...a,
      getRooms,
      on(evt: string, handler: Listener) {
        fire ??= handler;
        a.on(evt, handler);
      },
    });
    clients.set('@b:hs', fakeClient([fakeSpace('!s2:hs', { name: 'Play' })]));
    accountIds.set(['@a:hs', '@b:hs']);
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();
    getRooms.mockClear();

    // Without batching this re-reads every account's rooms once per event.
    fire?.();
    fire?.();
    fire?.();
    await flush();

    expect(getRooms).toHaveBeenCalledTimes(1);
  });
});
