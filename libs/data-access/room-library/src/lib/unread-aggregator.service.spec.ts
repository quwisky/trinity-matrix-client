import { ApplicationRef, WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ClientEvent, MatrixEventEvent, RoomEvent } from 'matrix-js-sdk';
import { describe, expect, it } from 'vitest';
import { UnreadAggregatorService } from './unread-aggregator.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

type Listener = (...args: unknown[]) => void;

let roomSeq = 0;

/** A room exposing just the bits the aggregator reads; `unread` is mutable per test. */
function fakeRoom(
  unread: number,
  opts: {
    space?: boolean;
    membership?: string;
    markedUnread?: boolean;
    id?: string;
    name?: string;
    ts?: number;
    avatarMxc?: string | null;
  } = {},
) {
  const room = {
    unread,
    roomId: opts.id ?? `!room${++roomSeq}:hs`,
    name: opts.name ?? 'Room',
    isSpaceRoom: () => opts.space ?? false,
    getMyMembership: () => opts.membership ?? 'join',
    getUnreadNotificationCount: () => room.unread,
    getLastActiveTimestamp: () => opts.ts ?? 0,
    getMxcAvatarUrl: () => opts.avatarMxc ?? null,
    getAvatarFallbackMember: () => undefined,
    getAccountData: (type: string) =>
      opts.markedUnread && type === 'm.marked_unread'
        ? { getContent: () => ({ unread: true }) }
        : undefined,
  };
  return room;
}

/** A client shaped like matrix-js-sdk's event emitter over a fixed room list. */
function fakeClient(
  rooms: ReturnType<typeof fakeRoom>[],
  direct: Record<string, string[]> = {},
) {
  const handlers = new Map<string, Set<Listener>>();
  return {
    getRooms: () => rooms,
    getAccountData: (type: string) =>
      type === 'm.direct' ? { getContent: () => direct } : undefined,
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

  it('recomputes when an encrypted message decrypts after its sync', async () => {
    // matrix-js-sdk ignores the server count in encrypted rooms and raises the room's
    // count itself on decryption, after the Sync that carried the ciphertext. The
    // system notification fires then too, so the dock badge must not wait for the
    // next sync.
    const { svc, accountIds, clients, flush } = harness();
    const room = fakeRoom(0);
    const client = fakeClient([room]);
    clients.set('@a:hs', client);
    accountIds.set(['@a:hs']);
    await flush();
    expect(svc.totalUnread()).toBe(0);

    room.unread = 1;
    client.emit(MatrixEventEvent.Decrypted);
    await flush();

    expect(svc.totalUnread()).toBe(1);
  });

  it('rebuilds the totals once for a burst of events fired within one task', async () => {
    const { svc, accountIds, clients, flush } = harness();
    const room = fakeRoom(2);
    const client = fakeClient([room]);
    clients.set('@a:hs', client);
    accountIds.set(['@a:hs']);
    await flush();
    expect(svc.totalUnread()).toBe(2);

    // Count getRooms reads for the burst only (flush() → unreadRoomsFor → getRooms once each).
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

  it('re-binds when an account is handed a NEW client object', async () => {
    // Re-adding / re-authenticating an already signed-in account stops the old client and
    // creates a new one under the same user id. Keying the listener by user id alone
    // strands it on the stopped client and freezes the badge at the pre-re-auth count.
    const { svc, accountIds, clients, flush } = harness();
    const old = fakeClient([fakeRoom(3)]);
    clients.set('@a:hs', old);
    accountIds.set(['@a:hs']);
    await flush();
    expect(svc.totalUnread()).toBe(3);

    const room = fakeRoom(7);
    const fresh = fakeClient([room]);
    clients.set('@a:hs', fresh);
    accountIds.set(['@a:hs']); // same id, new client
    await flush();

    expect(old.listenerCount()).toBe(0);
    expect(fresh.listenerCount()).toBeGreaterThan(0);

    // The live client's events must drive the badge, which is what the stranded
    // listener silently stopped doing.
    room.unread = 9;
    fresh.emit(ClientEvent.Sync);
    await flush();

    expect(svc.totalUnread()).toBe(9);
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

describe('unread chats', () => {
  it('lists every unread joined chat on every account with what the rail draws', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set(
      '@a:hs',
      fakeClient(
        [
          fakeRoom(2, {
            id: '!dm:hs',
            name: 'Bob',
            ts: 20,
            avatarMxc: 'mxc://hs/bob',
          }),
          fakeRoom(0, { id: '!read:hs' }),
        ],
        { '@bob:hs': ['!dm:hs'] },
      ),
    );
    clients.set(
      '@b:hs',
      fakeClient([fakeRoom(5, { id: '!team:hs', name: 'Team', ts: 30 })]),
    );
    accountIds.set(['@a:hs', '@b:hs']);
    await flush();

    expect(svc.unreadRooms()).toEqual([
      {
        accountId: '@a:hs',
        roomId: '!dm:hs',
        name: 'Bob',
        initial: 'B',
        avatarMxc: 'mxc://hs/bob',
        direct: true,
        unreadCount: 2,
        markedUnread: false,
        activityTs: 20,
      },
      {
        accountId: '@b:hs',
        roomId: '!team:hs',
        name: 'Team',
        initial: 'T',
        avatarMxc: null,
        direct: false,
        unreadCount: 5,
        markedUnread: false,
        activityTs: 30,
      },
    ]);
  });

  it('applies the app badge rule: no spaces, no invites, a flagged chat with no count stays', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set(
      '@a:hs',
      fakeClient([
        fakeRoom(4, { id: '!space:hs', space: true }),
        fakeRoom(4, { id: '!invite:hs', membership: 'invite' }),
        fakeRoom(0, { id: '!flagged:hs', markedUnread: true }),
      ]),
    );
    accountIds.set(['@a:hs']);
    await flush();

    expect(
      svc.unreadRooms().map((r) => [r.roomId, r.unreadCount, r.markedUnread]),
    ).toEqual([['!flagged:hs', 0, true]]);
    expect(svc.totalUnread()).toBe(1);
  });

  it('lists a room joined by two accounts once per account', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom(1, { id: '!shared:hs' })]));
    clients.set('@b:hs', fakeClient([fakeRoom(3, { id: '!shared:hs' })]));
    accountIds.set(['@a:hs', '@b:hs']);
    await flush();

    expect(svc.unreadRooms().map((r) => `${r.accountId} ${r.roomId}`)).toEqual([
      '@a:hs !shared:hs',
      '@b:hs !shared:hs',
    ]);
  });

  it('drops a chat once it is read', async () => {
    const { svc, accountIds, clients, flush } = harness();
    const room = fakeRoom(2, { id: '!x:hs' });
    const client = fakeClient([room]);
    clients.set('@a:hs', client);
    accountIds.set(['@a:hs']);
    await flush();
    expect(svc.unreadRooms()).toHaveLength(1);

    room.unread = 0;
    client.emit(RoomEvent.Receipt);
    await flush();

    expect(svc.unreadRooms()).toEqual([]);
  });

  it('drops a signed-out account’s chats', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom(1)]));
    clients.set('@b:hs', fakeClient([fakeRoom(1)]));
    accountIds.set(['@a:hs', '@b:hs']);
    await flush();

    accountIds.set(['@b:hs']);
    clients.delete('@a:hs');
    await flush();

    expect(svc.unreadRooms().map((r) => r.accountId)).toEqual(['@b:hs']);
  });

  it('keeps the same list object when a sync changes nothing', async () => {
    const { svc, accountIds, clients, flush } = harness();
    const client = fakeClient([fakeRoom(2, { id: '!x:hs', name: 'X', ts: 5 })]);
    clients.set('@a:hs', client);
    accountIds.set(['@a:hs']);
    await flush();
    const before = svc.unreadRooms();

    client.emit(ClientEvent.Sync);
    await flush();

    expect(svc.unreadRooms()).toBe(before);
  });
});
