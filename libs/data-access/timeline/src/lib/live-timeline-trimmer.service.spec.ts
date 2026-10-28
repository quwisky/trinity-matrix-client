import { ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ClientEvent,
  Direction,
  EventType,
  KnownMembership,
  MatrixEvent,
  MatrixEventEvent,
  NotificationCountType,
  Room,
  SyncState,
  createClient,
  type MatrixClient,
} from 'matrix-js-sdk';
import { EMPTY, Observable, concatWith, defer, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ConversationRuntime } from './conversation-runtime.service';
import { TRIM_HIGH_WATER, TRIM_KEEP } from './live-timeline-trim';
import { LiveTimelineTrimmer } from './live-timeline-trimmer.service';
import { scrollbackLive } from './js-sdk/live-scrollback';

const ALICE = '@alice:hs';
const MALLORY = '@mallory:hs';

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
    room.updateMyMembership(KnownMembership.Join);
    room.getLiveTimeline().setPaginationToken('start', Direction.Backward);
    client.store.storeRoom(room);
    return room;
  });
  const accountIds = signal<string[]>([]);
  const live = new Map<string, MatrixClient>([[ALICE, client]]);
  const held = new Set(['!open:hs']);
  const errors = { handleError: vi.fn() };
  const trimHeld = vi.fn();
  const refillHeld = vi.fn((): Observable<void> => EMPTY);
  const windowHidden = signal(false);
  const focused = signal<{ key: { accountId: string; roomId: string } } | null>(
    { key: { accountId: ALICE, roomId: '!open:hs' } },
  );
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
          trimHeld,
          refillHeld,
          windowHidden: windowHidden.asReadonly(),
          focused: focused.asReadonly(),
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
    trimHeld,
    refillHeld,
    windowHidden,
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

  it('leaves a held room past the high-water mark to the Conversation runtime', async () => {
    const { trimmer, accountIds, trimHeld, sync } = setup();
    const running = trimmer.run().subscribe();
    accountIds.set([ALICE]);
    TestBed.tick();

    for (let i = 0; i < 20; i++) await sync();
    expect(trimHeld).not.toHaveBeenCalled();

    await sync();
    expect(trimHeld).toHaveBeenCalledExactlyOnceWith(ALICE, '!open:hs');
    running.unsubscribe();
  });

  it('trims the focused room as soon as the window is hidden, without waiting for a sync', async () => {
    const { trimmer, accountIds, trimHeld, windowHidden, sync } = setup();
    const running = trimmer.run().subscribe();
    accountIds.set([ALICE]);
    TestBed.tick();
    for (let i = 0; i < 21; i++) await sync();
    expect(trimHeld).toHaveBeenCalledOnce();

    windowHidden.set(true);
    TestBed.tick();

    expect(trimHeld).toHaveBeenCalledTimes(2);
    expect(trimHeld).toHaveBeenLastCalledWith(ALICE, '!open:hs');
    running.unsubscribe();
  });

  it('reports a failing open room once, and trims it like any other once nobody has it open', async () => {
    const {
      trimmer,
      accountIds,
      errors,
      trimHeld,
      windowHidden,
      held,
      sync,
      loaded,
    } = setup();
    const failure = new Error('broken open room');
    trimHeld.mockImplementation(() => {
      throw failure;
    });
    const running = trimmer.run().subscribe();
    accountIds.set([ALICE]);
    TestBed.tick();

    for (let i = 0; i < 25; i++) await sync();
    // A later hidden period does not try it again.
    windowHidden.set(true);
    TestBed.tick();
    windowHidden.set(false);
    TestBed.tick();
    windowHidden.set(true);
    TestBed.tick();
    expect(trimHeld).toHaveBeenCalledOnce();
    expect(errors.handleError).toHaveBeenCalledExactlyOnceWith(failure);

    held.delete('!open:hs');
    for (let i = 0; i < 30; i++) await sync();

    expect(loaded('!open:hs')).toBeLessThanOrEqual(TRIM_HIGH_WATER + 10);
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

  describe('after an unblock', () => {
    const ignoring = (...userIds: string[]) =>
      new MatrixEvent({
        type: EventType.IgnoredUserList,
        content: {
          ignored_users: Object.fromEntries(userIds.map((id) => [id, {}])),
        },
      });

    function started() {
      const context = setup();
      const { client, trimmer, accountIds } = context;
      const busy = client.getRoom('!busy:hs')!;
      busy.currentState.setStateEvents([
        new MatrixEvent({
          type: EventType.RoomMember,
          event_id: '$mallory-join',
          room_id: busy.roomId,
          sender: MALLORY,
          state_key: MALLORY,
          content: { membership: 'join' },
        }),
      ]);
      const page = vi
        .spyOn(client, 'createMessagesRequest')
        .mockResolvedValue({ chunk: [], start: 's' });
      const running = trimmer.run().subscribe();
      accountIds.set([ALICE]);
      TestBed.tick();
      const timelines = () =>
        new Map(
          client
            .getRooms()
            .map((room) => [room.roomId, room.getLiveTimeline()]),
        );
      return { ...context, page, running, timelines };
    }

    it('rewinds the rooms the person may have written in, once, at the next sync', async () => {
      const { client, refillHeld, page, running, sync, loaded, timelines } =
        started();
      await sync();
      client.emit(ClientEvent.AccountData, ignoring(), ignoring(MALLORY));
      const before = timelines();
      expect(loaded('!busy:hs')).toBe(10);

      await sync();

      const after = timelines();
      expect(after.get('!quiet:hs')).toBe(before.get('!quiet:hs'));
      expect(loaded('!busy:hs')).toBe(0);
      expect(loaded('!open:hs')).toBe(0);
      expect(
        after.get('!open:hs')!.getPaginationToken(Direction.Backward),
      ).toBe('s20');
      expect(page).toHaveBeenCalledExactlyOnceWith(
        '!busy:hs',
        's20',
        30,
        Direction.Backward,
      );
      expect(refillHeld).toHaveBeenCalledExactlyOnceWith(ALICE, '!open:hs', 20);

      await sync();
      expect(page).toHaveBeenCalledOnce();
      expect(refillHeld).toHaveBeenCalledOnce();
      running.unsubscribe();
    });

    it('rewinds nothing for a block, the list as first loaded, or an unblock the server never echoed', async () => {
      const { client, refillHeld, page, running, sync, timelines } = started();
      client.emit(ClientEvent.AccountData, ignoring(MALLORY), undefined);
      client.emit(
        ClientEvent.AccountData,
        ignoring(MALLORY, '@eve:hs'),
        ignoring(MALLORY),
      );
      client.emit(
        ClientEvent.AccountData,
        new MatrixEvent({ type: EventType.Direct, content: {} }),
        new MatrixEvent({
          type: EventType.Direct,
          content: { [MALLORY]: ['!busy:hs'] },
        }),
      );
      const before = timelines();

      await sync();

      expect(timelines()).toEqual(before);
      expect(page).not.toHaveBeenCalled();
      expect(refillHeld).not.toHaveBeenCalled();
      running.unsubscribe();
    });

    it('leaves a room the account has not joined', async () => {
      const { client, page, running, sync } = started();
      client.getRoom('!busy:hs')!.updateMyMembership(KnownMembership.Leave);
      client.emit(ClientEvent.AccountData, ignoring(), ignoring(MALLORY));

      await sync();

      expect(page).not.toHaveBeenCalled();
      running.unsubscribe();
    });

    it('counts an unread message paged in again once, and a hidden one that is unread', async () => {
      const { client, page, running, sync, loaded } = started();
      const busy = client.getRoom('!busy:hs')!;
      await sync();
      busy.addReceipt(
        new MatrixEvent({
          type: EventType.Receipt,
          room_id: busy.roomId,
          content: {
            [message(busy.roomId, 5).getId()!]: {
              'm.read': { [ALICE]: { ts: 5 } },
            },
          },
        }),
      );
      // What the SDK's own decryption listener reads to count each unread event.
      vi.spyOn(client, 'getPushActionsForEvent').mockReturnValue({
        notify: true,
        tweaks: { highlight: true },
      });
      const hidden = new MatrixEvent({
        event_id: '$hidden',
        room_id: busy.roomId,
        type: 'm.room.message',
        sender: MALLORY,
        origin_server_ts: 11,
        content: { msgtype: 'm.text', body: 'hidden' },
      });
      page.mockResolvedValue({
        start: 's20',
        chunk: [
          hidden.event,
          ...Array.from(
            { length: 10 },
            (_, i) => message(busy.roomId, 10 - i).event,
          ),
        ],
      } as Awaited<ReturnType<MatrixClient['createMessagesRequest']>>);
      let decryptionDone!: () => void;
      const decrypting = new Promise<void>((resolve) => {
        decryptionDone = resolve;
      });
      vi.spyOn(MatrixEvent.prototype, 'getDecryptionPromise').mockReturnValue(
        decrypting,
      );
      client.emit(ClientEvent.AccountData, ignoring(), ignoring(MALLORY));
      busy.setUnreadNotificationCount(NotificationCountType.Total, 15);
      busy.setUnreadNotificationCount(NotificationCountType.Highlight, 15);

      // The rewind follows this sync, whose events were counted like the earlier ones.
      await sync();
      await vi.waitFor(() => expect(loaded('!busy:hs')).toBe(11));
      const counts = () => [
        busy.getUnreadNotificationCount(NotificationCountType.Total),
        busy.getUnreadNotificationCount(NotificationCountType.Highlight),
      ];
      const decrypt = (event: MatrixEvent) =>
        client.emit(MatrixEventEvent.Decrypted, event);
      const pagedIn = busy.getLiveTimeline().getEvents();
      const again = pagedIn.filter((event) => event.getId() !== '$hidden');

      for (const event of again) decrypt(event);
      expect(counts()).toEqual([15, 15]);

      decrypt(pagedIn.find((event) => event.getId() === '$hidden')!);
      expect(counts()).toEqual([16, 16]);

      // Once the page has decrypted, the room counts as usual again.
      decryptionDone();
      await vi.waitFor(() => {
        decrypt(again.at(-1)!);
        expect(counts()[0]).toBeGreaterThan(16);
      });
      running.unsubscribe();
    });

    it('holds the counts until a page that landed has decrypted, when a later page fails', async () => {
      const { client, errors, page, refillHeld, running, sync } = started();
      const open = client.getRoom('!open:hs')!;
      await sync();
      vi.spyOn(client, 'getPushActionsForEvent').mockReturnValue({
        notify: true,
        tweaks: { highlight: true },
      });
      page.mockResolvedValue({
        start: 's20',
        chunk: Array.from(
          { length: 10 },
          (_, i) => message(open.roomId, 10 - i).event,
        ),
      } as Awaited<ReturnType<MatrixClient['createMessagesRequest']>>);
      const failure = new Error('page failed');
      refillHeld.mockImplementation(() =>
        defer(() => scrollbackLive(client, open, 30)).pipe(
          concatWith(throwError(() => failure)),
        ),
      );
      let decryptionDone!: () => void;
      const decrypting = new Promise<void>((resolve) => {
        decryptionDone = resolve;
      });
      vi.spyOn(MatrixEvent.prototype, 'getDecryptionPromise').mockReturnValue(
        decrypting,
      );
      client.emit(ClientEvent.AccountData, ignoring(), ignoring(MALLORY));
      open.setUnreadNotificationCount(NotificationCountType.Total, 20);

      await sync();
      await vi.waitFor(() =>
        expect(errors.handleError).toHaveBeenCalledWith(failure),
      );
      for (const event of open.getLiveTimeline().getEvents()) {
        client.emit(MatrixEventEvent.Decrypted, event);
      }

      expect(open.getLiveTimeline().getEvents()).toHaveLength(10);
      expect(open.getUnreadNotificationCount(NotificationCountType.Total)).toBe(
        20,
      );
      decryptionDone();
      running.unsubscribe();
    });
  });
});
