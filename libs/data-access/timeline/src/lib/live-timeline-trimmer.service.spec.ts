import { ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ClientEvent,
  Direction,
  EventType,
  MatrixEvent,
  Room,
  SyncState,
  createClient,
  type MatrixClient,
} from 'matrix-js-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ConversationRuntime } from './conversation-runtime.service';
import { TRIM_HIGH_WATER, TRIM_KEEP } from './live-timeline-trim';
import { LiveTimelineTrimmer } from './live-timeline-trimmer.service';

const ALICE = '@alice:hs';

function message(roomId: string, n: number): MatrixEvent {
  return new MatrixEvent({
    event_id: `$${roomId}-${n}`,
    room_id: roomId,
    type: 'm.room.message',
    sender: '@bob:hs',
    origin_server_ts: n,
    content: { msgtype: 'm.text', body: `${n}` },
  });
}

/** A real SDK client whose rooms receive events in syncs of ten, as `/sync` would deliver. */
function setup() {
  const client = createClient({
    baseUrl: 'https://hs',
    userId: ALICE,
    fetchFn: () => Promise.reject(new Error('no network in unit tests')),
  });
  const rooms = ['!quiet:hs', '!busy:hs', '!open:hs'].map((roomId) => {
    const room = new Room(roomId, client, ALICE);
    room.getLiveTimeline().setPaginationToken('start', Direction.Backward);
    client.store.storeRoom(room);
    return room;
  });
  const accountIds = signal<string[]>([]);
  const live = new Map<string, MatrixClient>([[ALICE, client]]);
  const held = new Set(['!open:hs']);
  const errors = { handleError: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      {
        provide: MatrixClientService,
        useValue: {
          accountIds: accountIds.asReadonly(),
          clientFor: (id: string) => live.get(id) ?? null,
        },
      },
      {
        provide: ConversationRuntime,
        useValue: {
          holds: (accountId: string, roomId: string) =>
            accountId === ALICE && held.has(roomId),
        },
      },
      { provide: ErrorHandler, useValue: errors },
    ],
  });
  let received = 0;
  /** One sync: ten events for every room but the quiet one, then the Sync emit. */
  const sync = async (target: MatrixClient = client) => {
    for (const room of rooms.slice(1)) {
      await room.addLiveEvents(
        Array.from({ length: 10 }, (_, i) =>
          message(room.roomId, received + i + 1),
        ),
        { addToState: false },
      );
    }
    received += 10;
    target.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing, {
      nextSyncToken: `s${received}`,
    });
  };
  const loaded = (roomId: string) =>
    client.getRoom(roomId)!.getLiveTimeline().getEvents().length;
  return {
    client,
    trimmer: TestBed.inject(LiveTimelineTrimmer),
    accountIds,
    live,
    held,
    errors,
    sync,
    loaded,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('LiveTimelineTrimmer', () => {
  it('keeps a room nobody has open bounded while it keeps receiving events', async () => {
    const { trimmer, accountIds, sync, loaded } = setup();
    const running = trimmer.run().subscribe();
    accountIds.set([ALICE]);
    TestBed.tick();

    let most = 0;
    for (let i = 0; i < 100; i++) {
      await sync();
      most = Math.max(most, loaded('!busy:hs'));
    }

    // A trim follows the sync that crosses the high-water mark.
    expect(most).toBeLessThanOrEqual(TRIM_HIGH_WATER + 10);
    expect(loaded('!busy:hs')).toBeGreaterThanOrEqual(TRIM_KEEP);
    expect(loaded('!open:hs')).toBe(1000);
    expect(loaded('!quiet:hs')).toBe(0);
    running.unsubscribe();
  });

  it('stops trimming when its run ends or the Account goes away', async () => {
    const { trimmer, accountIds, sync, loaded } = setup();
    accountIds.set([ALICE]);
    const running = trimmer.run().subscribe();
    TestBed.tick();
    accountIds.set([]);
    TestBed.tick();
    for (let i = 0; i < 30; i++) await sync();
    expect(loaded('!busy:hs')).toBe(300);

    accountIds.set([ALICE]);
    TestBed.tick();
    running.unsubscribe();
    for (let i = 0; i < 30; i++) await sync();

    expect(loaded('!busy:hs')).toBe(600);
  });

  it('follows an Account to its new client', async () => {
    const { client, trimmer, accountIds, live, sync, loaded } = setup();
    const running = trimmer.run().subscribe();
    accountIds.set([ALICE]);
    TestBed.tick();
    const replacement = createClient({ baseUrl: 'https://hs', userId: ALICE });
    live.set(ALICE, replacement);
    accountIds.set([ALICE, '@other:hs']);
    TestBed.tick();

    for (let i = 0; i < 30; i++) await sync(client);

    expect(loaded('!busy:hs')).toBe(300);
    running.unsubscribe();
  });

  it('does not rescan a room a sync brought nothing new', async () => {
    const { client, trimmer, accountIds, sync, loaded } = setup();
    const busy = client.getRoom('!busy:hs')!;
    const running = trimmer.run().subscribe();
    accountIds.set([ALICE]);
    TestBed.tick();
    await sync();
    // Read once, then left: the receipt keeps everything after it below the ceiling.
    busy.addReceipt(
      new MatrixEvent({
        type: EventType.Receipt,
        room_id: busy.roomId,
        content: {
          [message(busy.roomId, 1).getId()!]: {
            'm.read': { [ALICE]: { ts: 1 } },
          },
        },
      }),
    );
    for (let i = 0; i < 25; i++) await sync();
    expect(loaded('!busy:hs')).toBe(260);
    const attempts = vi.spyOn(busy, 'getEventReadUpTo');

    client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing, {
      nextSyncToken: 's-idle',
    });
    expect(attempts).not.toHaveBeenCalled();

    await sync();
    expect(attempts).toHaveBeenCalled();
    running.unsubscribe();
  });

  it('reports a room it fails to trim once and leaves it alone', async () => {
    const { client, trimmer, accountIds, errors, sync } = setup();
    const failure = new Error('broken room');
    vi.spyOn(
      client.getRoom('!busy:hs')!,
      'getEventReadUpTo',
    ).mockImplementation(() => {
      throw failure;
    });
    const running = trimmer.run().subscribe();
    accountIds.set([ALICE]);
    TestBed.tick();

    for (let i = 0; i < 40; i++) await sync();

    expect(errors.handleError).toHaveBeenCalledOnce();
    expect(errors.handleError).toHaveBeenCalledWith(failure);
    running.unsubscribe();
  });
});
