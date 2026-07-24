import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { NotificationCountType } from 'matrix-js-sdk';
import { MixedRoomsService } from './mixed-rooms.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

type Listener = (...args: unknown[]) => void;

/** A room exposing just the fields buildRoomSummary + the filters read. */
function fakeRoom(
  id: string,
  opts: {
    name?: string;
    space?: boolean;
    membership?: string;
    activityTs?: number;
    favourite?: boolean;
    unread?: number;
    highlight?: number;
  } = {},
) {
  return {
    roomId: id,
    name: opts.name ?? id,
    isSpaceRoom: () => opts.space ?? false,
    getMyMembership: () => opts.membership ?? 'join',
    getMxcAvatarUrl: () => null,
    getJoinedMemberCount: () => 1,
    hasEncryptionStateEvent: () => false,
    getUnreadNotificationCount: (type?: unknown) =>
      type === NotificationCountType.Highlight
        ? (opts.highlight ?? 0)
        : (opts.unread ?? 0),
    getLastActiveTimestamp: () => opts.activityTs ?? 0,
    getLiveTimeline: () => ({
      getEvents: () => [],
      getState: () => undefined, // no topic state in the fake
    }),
    tags: opts.favourite ? { 'm.favourite': {} } : {},
  };
}

/** A client shaped like matrix-js-sdk's event emitter over a fixed room list. */
function fakeClient(
  rooms: ReturnType<typeof fakeRoom>[],
  direct: string[] = [],
) {
  const handlers = new Map<string, Set<Listener>>();
  return {
    getRooms: () => rooms,
    getAccountData: (type: string) =>
      type === 'm.direct'
        ? { getContent: () => ({ '@peer:hs': direct }) }
        : undefined,
    on(evt: string, handler: Listener) {
      (handlers.get(evt) ?? handlers.set(evt, new Set()).get(evt)!).add(
        handler,
      );
    },
    off(evt: string, handler: Listener) {
      handlers.get(evt)?.delete(handler);
    },
    emit(evt: string) {
      handlers.get(evt)?.forEach((handler) => handler());
    },
    listenerCount() {
      let total = 0;
      handlers.forEach((set) => (total += set.size));
      return total;
    },
  };
}

function harness(): {
  svc: MixedRoomsService;
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
      MixedRoomsService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  const svc = TestBed.inject(MixedRoomsService);
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return { svc, accountIds, activeUserId, clients, flush };
}

describe('MixedRoomsService', () => {
  it('does nothing until accounts are selected', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom('!r:hs')]));
    accountIds.set(['@a:hs']);
    await flush();

    expect(svc.rooms()).toEqual([]);
    expect(clients.get('@a:hs')!.listenerCount()).toBe(0);
  });

  it('aggregates the selected accounts’ rooms, tagged, sorted across accounts', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set(
      '@a:hs',
      fakeClient([fakeRoom('!old:hs', { name: 'Old', activityTs: 100 })]),
    );
    clients.set(
      '@b:hs',
      fakeClient([
        fakeRoom('!new:hs', { name: 'New', activityTs: 300 }),
        fakeRoom('!fav:hs', { name: 'Fav', activityTs: 50, favourite: true }),
        fakeRoom('!space:hs', { space: true }), // spaces excluded
      ]),
    );
    accountIds.set(['@a:hs', '@b:hs']);
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();

    // Favourite first, then most-recent, across both accounts; spaces dropped.
    expect(svc.rooms().map((r) => [r.id, r.accountId])).toEqual([
      ['!fav:hs', '@b:hs'],
      ['!new:hs', '@b:hs'],
      ['!old:hs', '@a:hs'],
    ]);
  });

  // The point of the picker: a signed-in account you did not tick contributes nothing and
  // costs nothing (no listener), rather than being aggregated and filtered out later.
  it('ignores signed-in accounts that are not selected', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom('!a:hs')]));
    clients.set('@b:hs', fakeClient([fakeRoom('!b:hs')]));
    clients.set('@c:hs', fakeClient([fakeRoom('!c:hs')]));
    accountIds.set(['@a:hs', '@b:hs', '@c:hs']);
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();

    expect(
      svc
        .rooms()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['!a:hs', '!b:hs']);
    expect(clients.get('@c:hs')!.listenerCount()).toBe(0);
  });

  // Two mixed accounts can be joined to the SAME room. Emitting both would put duplicate
  // ids in the list, so `find(r => r.id === …)` — how a click resolves its account — could
  // return the other account's row and open the room as the wrong identity.
  it('emits one row per room when two accounts share it, preferring the active account', async () => {
    const { svc, accountIds, activeUserId, clients, flush } = harness();
    clients.set(
      '@a:hs',
      fakeClient([fakeRoom('!shared:hs', { name: 'Shared' })]),
    );
    clients.set(
      '@b:hs',
      fakeClient([fakeRoom('!shared:hs', { name: 'Shared' })]),
    );
    accountIds.set(['@a:hs', '@b:hs']);
    activeUserId.set('@b:hs');
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();

    expect(svc.rooms().map((r) => r.id)).toEqual(['!shared:hs']);
    // The active account's copy wins, so opening it acts as the account already in use.
    expect(svc.rooms()[0].accountId).toBe('@b:hs');
  });

  // Dropping the losing copy wholesale would hide a mention that landed on it.
  it('keeps the loudest unread of the two copies of a shared room', async () => {
    const { svc, accountIds, activeUserId, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom('!shared:hs', { unread: 0 })]));
    clients.set(
      '@b:hs',
      fakeClient([fakeRoom('!shared:hs', { unread: 3, highlight: 2 })]),
    );
    accountIds.set(['@a:hs', '@b:hs']);
    activeUserId.set('@a:hs'); // the read copy would otherwise win outright
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();

    const row = svc.rooms()[0];
    expect(row.accountId).toBe('@a:hs'); // identity still prefers the active account
    expect(row.unreadCount).toBe(3);
    expect(row.highlightCount).toBe(2);
    expect(row.hasUnread).toBe(true);
  });

  it('re-attributes a shared room when the active account changes', async () => {
    const { svc, accountIds, activeUserId, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom('!shared:hs')]));
    clients.set('@b:hs', fakeClient([fakeRoom('!shared:hs')]));
    accountIds.set(['@a:hs', '@b:hs']);
    activeUserId.set('@a:hs');
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();
    expect(svc.rooms()[0].accountId).toBe('@a:hs');

    // Switching accounts emits no client event, so without an explicit re-flush the row
    // would stay tagged @a and clicking it would switch straight back.
    activeUserId.set('@b:hs');
    TestBed.tick();
    await flush();
    expect(svc.rooms()[0].accountId).toBe('@b:hs');
  });

  it('picks a stable owner for a shared room when neither account is active', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@b:hs', fakeClient([fakeRoom('!shared:hs')]));
    clients.set('@a:hs', fakeClient([fakeRoom('!shared:hs')]));
    accountIds.set(['@b:hs', '@a:hs']);
    svc.setAccounts(new Set(['@b:hs', '@a:hs']));
    await flush();

    expect(svc.rooms().length).toBe(1);
    expect(svc.rooms()[0].accountId).toBe('@a:hs'); // first by sorted account id
  });

  it('classifies a room as a DM from its own account’s m.direct', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom('!dm:hs')], ['!dm:hs']));
    clients.set('@b:hs', fakeClient([fakeRoom('!other:hs')]));
    accountIds.set(['@a:hs', '@b:hs']);
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();

    expect(svc.rooms().find((r) => r.id === '!dm:hs')?.directUserId).toBe(
      '@peer:hs',
    );
    // The other account's room is not a DM just because this one's is.
    expect(
      svc.rooms().find((r) => r.id === '!other:hs')?.directUserId,
    ).toBeUndefined();
  });

  it('detaches every listener and clears the list when the mix drops below two', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom('!a:hs')]));
    clients.set('@b:hs', fakeClient([fakeRoom('!b:hs')]));
    accountIds.set(['@a:hs', '@b:hs']);
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();
    expect(svc.rooms().length).toBe(2);
    expect(clients.get('@a:hs')!.listenerCount()).toBeGreaterThan(0);

    // One account left selected is not a mix — the plain RoomsService covers that.
    svc.setAccounts(new Set(['@a:hs']));
    expect(svc.rooms()).toEqual([]);
    expect(clients.get('@a:hs')!.listenerCount()).toBe(0);
    expect(clients.get('@b:hs')!.listenerCount()).toBe(0);
  });

  it('re-applying an equal selection does not churn listeners', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom('!a:hs')]));
    clients.set('@b:hs', fakeClient([fakeRoom('!b:hs')]));
    accountIds.set(['@a:hs', '@b:hs']);
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();
    const before = clients.get('@a:hs')!.listenerCount();

    // A fresh Set with the same members (what a recomputed signal hands us) is a no-op.
    svc.setAccounts(new Set(['@b:hs', '@a:hs']));
    await flush();
    expect(clients.get('@a:hs')!.listenerCount()).toBe(before);
    expect(svc.rooms().length).toBe(2);
  });

  it('reconciles the selection against accounts signing in and out', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom('!a:hs')]));
    accountIds.set(['@a:hs']);
    // Both are selected, but only @a is signed in so far.
    svc.setAccounts(new Set(['@a:hs', '@b:hs']));
    await flush();
    expect(svc.rooms().map((r) => r.id)).toEqual(['!a:hs']);

    // @b signs in; nudge an event so the flush re-reconciles.
    clients.set('@b:hs', fakeClient([fakeRoom('!b:hs')]));
    accountIds.set(['@a:hs', '@b:hs']);
    clients.get('@a:hs')!.emit('Room');
    await flush();
    expect(
      svc
        .rooms()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['!a:hs', '!b:hs']);

    // @a signs out; its listener is detached and its rooms drop.
    const gone = clients.get('@a:hs')!;
    accountIds.set(['@b:hs']);
    clients.get('@b:hs')!.emit('Room');
    await flush();
    expect(svc.rooms().map((r) => r.id)).toEqual(['!b:hs']);
    expect(gone.listenerCount()).toBe(0);
  });
});
