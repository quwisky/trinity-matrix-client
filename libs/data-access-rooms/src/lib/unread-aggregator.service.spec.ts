import { ApplicationRef, WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ClientEvent, RoomEvent } from 'matrix-js-sdk';
import { describe, expect, it } from 'vitest';
import { UnreadAggregatorService } from './unread-aggregator.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

type Listener = (...args: unknown[]) => void;

/** A room exposing just the bits the aggregator reads; `unread` is mutable per test. */
function fakeRoom(
  unread: number,
  opts: { space?: boolean; membership?: string; markedUnread?: boolean } = {},
) {
  const room = {
    unread,
    isSpaceRoom: () => opts.space ?? false,
    getMyMembership: () => opts.membership ?? 'join',
    getUnreadNotificationCount: () => room.unread,
    getAccountData: (type: string) =>
      opts.markedUnread && type === 'm.marked_unread'
        ? { getContent: () => ({ unread: true }) }
        : undefined,
  };
  return room;
}

/** A client shaped like matrix-js-sdk's event emitter over a fixed room list. */
function fakeClient(rooms: ReturnType<typeof fakeRoom>[]) {
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
  svc: UnreadAggregatorService;
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
      UnreadAggregatorService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  const svc = TestBed.inject(UnreadAggregatorService);
  const appRef = TestBed.inject(ApplicationRef);
  // Run the reconcile effect, then drain the coalescing microtask that writes totals.
  const flush = async (): Promise<void> => {
    appRef.tick();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { svc, accountIds, clients, flush };
}

describe('UnreadAggregatorService', () => {
  it('sums unread across every signed-in account', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom(3)]));
    clients.set('@b:hs', fakeClient([fakeRoom(2), fakeRoom(4)]));
    accountIds.set(['@a:hs', '@b:hs']);

    await flush();

    expect(svc.totalUnread()).toBe(9);
    expect(svc.unreadByAccount().get('@a:hs')).toBe(3);
    expect(svc.unreadByAccount().get('@b:hs')).toBe(6);
  });

  it('counts only joined, non-space rooms', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set(
      '@a:hs',
      fakeClient([
        fakeRoom(3),
        fakeRoom(10, { space: true }),
        fakeRoom(7, { membership: 'invite' }),
      ]),
    );
    accountIds.set(['@a:hs']);

    await flush();

    expect(svc.totalUnread()).toBe(3);
  });

  it('recomputes an account total when its client fires a sync event', async () => {
    const { svc, accountIds, clients, flush } = harness();
    const room = fakeRoom(2);
    const client = fakeClient([room]);
    clients.set('@a:hs', client);
    accountIds.set(['@a:hs']);
    await flush();
    expect(svc.totalUnread()).toBe(2);

    room.unread = 9;
    client.emit(ClientEvent.Sync);
    await flush();

    expect(svc.totalUnread()).toBe(9);
  });

  it('rebuilds the totals once for a burst of events fired within one task', async () => {
    const { svc, accountIds, clients, flush } = harness();
    const room = fakeRoom(2);
    const client = fakeClient([room]);
    clients.set('@a:hs', client);
    accountIds.set(['@a:hs']);
    await flush();
    expect(svc.totalUnread()).toBe(2);

    // Count getRooms reads for the burst only (flush() → unreadFor → getRooms once each).
    let getRoomsCalls = 0;
    const readRooms = client.getRooms;
    client.getRooms = () => {
      getRoomsCalls += 1;
      return readRooms();
    };

    // Several unread-affecting events fire synchronously within one task.
    room.unread = 9;
    client.emit(ClientEvent.Sync);
    client.emit(ClientEvent.Sync);
    client.emit(RoomEvent.Receipt);
    await flush();

    // The coalescer collapses the burst: one rebuild, one getRooms read — not one per event.
    expect(getRoomsCalls).toBe(1);
    expect(svc.totalUnread()).toBe(9);
  });

  it('attaches to an account added later and drops one signed out', async () => {
    const { svc, accountIds, clients, flush } = harness();
    const a = fakeClient([fakeRoom(3)]);
    clients.set('@a:hs', a);
    accountIds.set(['@a:hs']);
    await flush();
    expect(svc.totalUnread()).toBe(3);

    clients.set('@b:hs', fakeClient([fakeRoom(5)]));
    accountIds.set(['@a:hs', '@b:hs']);
    await flush();
    expect(svc.totalUnread()).toBe(8);

    // Sign @a out: its total is dropped and its listeners detached.
    accountIds.set(['@b:hs']);
    clients.delete('@a:hs');
    await flush();

    expect(svc.totalUnread()).toBe(5);
    expect(svc.unreadByAccount().has('@a:hs')).toBe(false);
    expect(a.listenerCount()).toBe(0);
  });

  describe('rooms flagged to come back to', () => {
    it('counts a flagged room even though the server counts it as zero', async () => {
      // Without this the flag is visible nowhere but the one sidebar list that happens
      // to show the room: the rail pills and the app-icon badge both sum server counts,
      // which stay at zero because the read receipt never moved.
      const { svc, accountIds, clients, flush } = harness();
      clients.set(
        '@a:hs',
        fakeClient([fakeRoom(0, { markedUnread: true }), fakeRoom(0)]),
      );
      accountIds.set(['@a:hs']);

      await flush();

      expect(svc.totalUnread()).toBe(1);
    });

    it('does not double-count a flagged room that also has notifications', async () => {
      const { svc, accountIds, clients, flush } = harness();
      clients.set('@a:hs', fakeClient([fakeRoom(3, { markedUnread: true })]));
      accountIds.set(['@a:hs']);

      await flush();

      expect(svc.totalUnread()).toBe(3);
    });
  });

  it('recomputes when a room’s account data changes', async () => {
    // Both flag tests above set the flag BEFORE the first flush, so they pass with no
    // listener at all. This is what proves the app-icon badge reacts to a flag set on
    // another device rather than waiting for an unrelated event.
    const { svc, accountIds, clients, flush } = harness();
    const room = fakeRoom(0);
    clients.set('@a:hs', fakeClient([room]));
    accountIds.set(['@a:hs']);
    await flush();
    expect(svc.totalUnread()).toBe(0);

    room.getAccountData = (type: string) =>
      type === 'm.marked_unread'
        ? { getContent: () => ({ unread: true }) }
        : undefined;
    clients.get('@a:hs')!.emit(RoomEvent.AccountData);
    await flush();

    expect(svc.totalUnread()).toBe(1);
  });
});
