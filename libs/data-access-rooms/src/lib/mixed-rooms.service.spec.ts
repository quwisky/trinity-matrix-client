import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
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
    getUnreadNotificationCount: () => 0,
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
      MixedRoomsService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  const svc = TestBed.inject(MixedRoomsService);
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return { svc, accountIds, clients, flush };
}

describe('MixedRoomsService', () => {
  it('does nothing while disabled', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom('!r:hs')]));
    accountIds.set(['@a:hs']);
    await flush();

    expect(svc.rooms()).toEqual([]);
    expect(clients.get('@a:hs')!.listenerCount()).toBe(0);
  });

  it('aggregates every account’s rooms, tagged with the account, sorted across accounts', async () => {
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
    svc.setEnabled(true);
    await flush();

    // Favourite first, then most-recent, across both accounts; spaces dropped.
    expect(svc.rooms().map((r) => [r.id, r.accountId])).toEqual([
      ['!fav:hs', '@b:hs'],
      ['!new:hs', '@b:hs'],
      ['!old:hs', '@a:hs'],
    ]);
  });

  it('classifies a room as a DM from its own account’s m.direct', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom('!dm:hs')], ['!dm:hs']));
    accountIds.set(['@a:hs']);
    svc.setEnabled(true);
    await flush();

    expect(svc.rooms()[0].directUserId).toBe('@peer:hs');
  });

  it('detaches every listener and clears the list when disabled', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom('!r:hs')]));
    accountIds.set(['@a:hs']);
    svc.setEnabled(true);
    await flush();
    expect(svc.rooms().length).toBe(1);
    expect(clients.get('@a:hs')!.listenerCount()).toBeGreaterThan(0);

    svc.setEnabled(false);
    expect(svc.rooms()).toEqual([]);
    expect(clients.get('@a:hs')!.listenerCount()).toBe(0);
  });

  it('reconciles when an account is added or removed', async () => {
    const { svc, accountIds, clients, flush } = harness();
    clients.set('@a:hs', fakeClient([fakeRoom('!a:hs')]));
    accountIds.set(['@a:hs']);
    svc.setEnabled(true);
    await flush();
    expect(svc.rooms().map((r) => r.id)).toEqual(['!a:hs']);

    // Add a second account and nudge an event so the flush re-reconciles.
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

    // Remove the first; its listener is detached and its rooms drop.
    const gone = clients.get('@a:hs')!;
    accountIds.set(['@b:hs']);
    clients.get('@b:hs')!.emit('Room');
    await flush();
    expect(svc.rooms().map((r) => r.id)).toEqual(['!b:hs']);
    expect(gone.listenerCount()).toBe(0);
  });
});
