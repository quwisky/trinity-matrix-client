import { ErrorHandler } from '@angular/core';
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
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JS_SDK_CLIENTS,
  SESSION_ENGINE,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import type { RetentionHint } from '../timeline-engine';
import { JsSdkTimelineEngine } from './js-sdk-timeline-engine';
import { TRIM_HIGH_WATER, TRIM_KEEP } from './live-timeline-trim';

const ALICE = '@alice:hs';
const MALLORY = '@mallory:hs';

const SCROLLED_BACK: RetentionHint = {
  shown: true,
  followingLive: false,
  windowHidden: true,
  kept: [],
  marked: [],
};
const HIDDEN_AT_LIVE: RetentionHint = { ...SCROLLED_BACK, followingLive: true };

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

function sessionOf(
  accounts: readonly (readonly [string, number])[],
): SessionSnapshot {
  return {
    activeAccountId: accounts[0]?.[0] ?? null,
    accounts: accounts.map(([accountId, generation]) => ({
      accountId,
      generation,
    })),
    softLoggedOut: [],
  } as unknown as SessionSnapshot;
}

/** A real SDK client whose rooms receive events in syncs of ten, as `/sync` would deliver. */
function setup(options: { live?: boolean } = {}) {
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
  const live = new Map<string, MatrixClient>([[ALICE, client]]);
  const session = new BehaviorSubject(
    sessionOf(options.live === false ? [] : [[ALICE, 1]]),
  );
  const errors = { handleError: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      {
        provide: JS_SDK_CLIENTS,
        useValue: { clientFor: (id: string) => live.get(id) ?? null },
      },
      { provide: SESSION_ENGINE, useValue: { session: () => session } },
      { provide: ErrorHandler, useValue: errors },
    ],
  });
  // The SDK's own listeners, before the engine binds its loop.
  const syncListeners = client.listenerCount(ClientEvent.Sync);
  const engine = TestBed.inject(JsSdkTimelineEngine);
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
  const retain = (roomId: string, hint: RetentionHint | null) =>
    firstValueFrom(engine.setRetention(ALICE, roomId, hint));
  return {
    client,
    syncListeners,
    engine,
    session,
    live,
    errors,
    sync,
    loaded,
    retain,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('JsSdkTimelineEngine retention', () => {
  it('keeps a room nobody holds bounded while it keeps receiving events', async () => {
    const { sync, loaded, retain } = setup();
    await retain('!open:hs', SCROLLED_BACK);

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
  });

  it('never trims a held room that is not following live', async () => {
    const { sync, loaded, retain } = setup();
    await retain('!open:hs', SCROLLED_BACK);
    for (let i = 0; i < 30; i++) await sync();

    await retain('!open:hs', SCROLLED_BACK);
    await retain('!open:hs', { ...HIDDEN_AT_LIVE, windowHidden: false });
    await sync();

    expect(loaded('!open:hs')).toBe(310);
  });

  it('trims a held room following live while the window is hidden, keeping what it names', async () => {
    const { sync, loaded, retain, client } = setup();
    await retain('!open:hs', SCROLLED_BACK);
    for (let i = 0; i < 25; i++) await sync();
    const kept = '$!open:hs-150';

    await retain('!open:hs', { ...HIDDEN_AT_LIVE, kept: [kept] });

    const events = client.getRoom('!open:hs')!.getLiveTimeline().getEvents();
    expect(events.length).toBeLessThan(250);
    expect(events.some((event) => event.getId() === kept)).toBe(true);

    await retain('!open:hs', HIDDEN_AT_LIVE);
    for (let i = 0; i < 20; i++) await sync();
    expect(loaded('!open:hs')).toBeLessThanOrEqual(TRIM_HIGH_WATER + 10);
  });

  it('trims a released room at once once it is past the high-water mark', async () => {
    const { sync, loaded, retain } = setup();
    await retain('!open:hs', SCROLLED_BACK);
    for (let i = 0; i < 25; i++) await sync();

    await retain('!open:hs', null);

    expect(loaded('!open:hs')).toBeLessThanOrEqual(2 * TRIM_KEEP);
  });

  it('trims a released room on the next sync', async () => {
    const { sync, loaded, retain } = setup();
    await retain('!open:hs', SCROLLED_BACK);
    for (let i = 0; i < 15; i++) await sync();

    await retain('!open:hs', null);
    expect(loaded('!open:hs')).toBe(150);
    for (let i = 0; i < 6; i++) await sync();

    expect(loaded('!open:hs')).toBeLessThanOrEqual(TRIM_HIGH_WATER);
    expect(loaded('!open:hs')).toBeGreaterThanOrEqual(TRIM_KEEP);
  });

  it('leaves a room an open timeline shows to its hint', async () => {
    const { engine, sync, loaded } = setup();
    const shown = engine.timeline(ALICE, '!busy:hs', { kind: 'live' });
    const subscription = shown.subscribe();
    for (let i = 0; i < 25; i++) await sync();
    expect(loaded('!busy:hs')).toBe(250);

    subscription.unsubscribe();
    await sync();

    expect(loaded('!busy:hs')).toBeLessThanOrEqual(TRIM_HIGH_WATER);
  });

  it('reports a failing held room once, and trims it like any other once released', async () => {
    const { client, errors, sync, loaded, retain } = setup();
    await retain('!open:hs', HIDDEN_AT_LIVE);
    const open = client.getRoom('!open:hs')!;
    const failure = new Error('broken open room');
    const reads = vi.spyOn(open, 'getEventReadUpTo').mockImplementation(() => {
      throw failure;
    });

    for (let i = 0; i < 25; i++) await sync();
    await retain('!open:hs', SCROLLED_BACK);
    await retain('!open:hs', HIDDEN_AT_LIVE);
    expect(errors.handleError).toHaveBeenCalledExactlyOnceWith(failure);

    reads.mockRestore();
    await retain('!open:hs', null);
    await sync();

    expect(loaded('!open:hs')).toBeLessThanOrEqual(TRIM_HIGH_WATER);
  });

  it('binds one loop per live account and generation and drops it when the account leaves', async () => {
    const { client, syncListeners, session, live, sync, loaded } = setup({
      live: false,
    });
    const listeners = (target: MatrixClient) =>
      target.listenerCount(ClientEvent.Sync) - syncListeners;
    for (let i = 0; i < 25; i++) await sync();
    expect(loaded('!busy:hs')).toBe(250);
    expect(listeners(client)).toBe(0);

    session.next(sessionOf([[ALICE, 1]]));
    session.next(sessionOf([[ALICE, 1]]));
    session.next(
      sessionOf([
        [ALICE, 1],
        ['@other:hs', 1],
      ]),
    );
    expect(listeners(client)).toBe(1);
    // The first sync positions are recorded only once the loop runs.
    for (let i = 0; i < 10; i++) await sync();
    expect(loaded('!busy:hs')).toBeLessThanOrEqual(TRIM_HIGH_WATER);

    const replacement = createClient({ baseUrl: 'https://hs', userId: ALICE });
    live.set(ALICE, replacement);
    session.next(sessionOf([[ALICE, 2]]));
    expect(listeners(client)).toBe(0);
    expect(listeners(replacement)).toBe(1);
    for (let i = 0; i < 25; i++) await sync(client);
    expect(loaded('!busy:hs')).toBeGreaterThan(TRIM_HIGH_WATER);

    session.next(sessionOf([]));
    expect(listeners(replacement)).toBe(0);
  });

  it('stops every loop when the engine is destroyed', () => {
    const { client, syncListeners } = setup();
    expect(client.listenerCount(ClientEvent.Sync)).toBe(syncListeners + 1);

    TestBed.resetTestingModule();

    expect(client.listenerCount(ClientEvent.Sync)).toBe(syncListeners);
  });

  it('does not rescan a room a sync brought nothing new', async () => {
    const { client, sync, loaded } = setup();
    const busy = client.getRoom('!busy:hs')!;
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
  });

  it('reports a room it fails to trim once and leaves it alone', async () => {
    const { client, errors, sync } = setup();
    const failure = new Error('broken room');
    vi.spyOn(
      client.getRoom('!busy:hs')!,
      'getEventReadUpTo',
    ).mockImplementation(() => {
      throw failure;
    });

    for (let i = 0; i < 40; i++) await sync();

    expect(errors.handleError).toHaveBeenCalledOnce();
    expect(errors.handleError).toHaveBeenCalledWith(failure);
  });

  describe('after an unblock', () => {
    const ignoring = (...userIds: string[]) =>
      new MatrixEvent({
        type: EventType.IgnoredUserList,
        content: {
          ignored_users: Object.fromEntries(userIds.map((id) => [id, {}])),
        },
      });

    async function started() {
      const context = setup();
      const { client, retain } = context;
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
      await retain('!open:hs', SCROLLED_BACK);
      const timelines = () =>
        new Map(
          client
            .getRooms()
            .map((room) => [room.roomId, room.getLiveTimeline()]),
        );
      return { ...context, page, timelines };
    }

    it('rewinds and refills held rooms when the ignored-user list changes', async () => {
      const { client, page, sync, loaded, timelines } = await started();
      await sync();
      client.emit(ClientEvent.AccountData, ignoring(), ignoring(MALLORY));
      const before = timelines();
      expect(loaded('!busy:hs')).toBe(10);

      await sync();

      const after = timelines();
      expect(after.get('!quiet:hs')).toBe(before.get('!quiet:hs'));
      expect(loaded('!busy:hs')).toBe(0);
      expect(loaded('!open:hs')).toBe(0);
      await vi.waitFor(() => expect(page).toHaveBeenCalledTimes(2));
      expect(page).toHaveBeenCalledWith(
        '!busy:hs',
        's20',
        30,
        Direction.Backward,
      );
      expect(page).toHaveBeenCalledWith(
        '!open:hs',
        's20',
        30,
        Direction.Backward,
      );

      await sync();
      await Promise.resolve();
      expect(page).toHaveBeenCalledTimes(2);
    });

    it('refills a held room to about its depth while it is shown, one page while not', async () => {
      const { client, page, sync, retain } = await started();
      await sync();
      await sync();
      page.mockImplementation((roomId: string) =>
        Promise.resolve({
          start: 's',
          end: 'older',
          chunk: Array.from(
            { length: 5 },
            (_, i) =>
              message(roomId, 100 + page.mock.calls.length * 5 + i).event,
          ),
        } as Awaited<ReturnType<MatrixClient['createMessagesRequest']>>),
      );
      client.emit(ClientEvent.AccountData, ignoring(), ignoring(MALLORY));

      await sync();

      await vi.waitFor(() =>
        expect(
          page.mock.calls.filter(([roomId]) => roomId === '!open:hs'),
        ).toHaveLength(6),
      );

      await retain('!open:hs', { ...SCROLLED_BACK, shown: false });
      client.emit(ClientEvent.AccountData, ignoring(), ignoring(MALLORY));
      await sync();
      await vi.waitFor(() =>
        expect(
          page.mock.calls.filter(([roomId]) => roomId === '!open:hs'),
        ).toHaveLength(7),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        page.mock.calls.filter(([roomId]) => roomId === '!open:hs'),
      ).toHaveLength(7);
    });

    it('rewinds nothing for a block, the list as first loaded, or an unblock the server never echoed', async () => {
      const { client, page, sync, timelines } = await started();
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
    });

    it('leaves a room the account has not joined', async () => {
      const { client, page, sync } = await started();
      client.getRoom('!busy:hs')!.updateMyMembership(KnownMembership.Leave);
      client.getRoom('!open:hs')!.updateMyMembership(KnownMembership.Leave);
      client.emit(ClientEvent.AccountData, ignoring(), ignoring(MALLORY));

      await sync();

      expect(page).not.toHaveBeenCalled();
    });

    it('counts an unread message paged in again once, and a hidden one that is unread', async () => {
      const { client, page, sync, loaded } = await started();
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
      page.mockImplementation((roomId: string) =>
        Promise.resolve(
          (roomId === busy.roomId
            ? {
                start: 's20',
                chunk: [
                  hidden.event,
                  ...Array.from(
                    { length: 10 },
                    (_, i) => message(busy.roomId, 10 - i).event,
                  ),
                ],
              }
            : { start: 's20', chunk: [] }) as Awaited<
            ReturnType<MatrixClient['createMessagesRequest']>
          >,
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
    });

    it('holds the counts until a page that landed has decrypted, when a later page fails', async () => {
      const { client, errors, page, sync } = await started();
      const open = client.getRoom('!open:hs')!;
      await sync();
      vi.spyOn(client, 'getPushActionsForEvent').mockReturnValue({
        notify: true,
        tweaks: { highlight: true },
      });
      const failure = new Error('page failed');
      page.mockImplementation((roomId: string, from: string | null) =>
        roomId !== open.roomId
          ? Promise.resolve({ start: 's', chunk: [] })
          : from === 's20'
            ? Promise.resolve({
                start: 's20',
                end: 's10',
                chunk: Array.from(
                  { length: 5 },
                  (_, i) => message(open.roomId, 10 - i).event,
                ),
              } as Awaited<ReturnType<MatrixClient['createMessagesRequest']>>)
            : Promise.reject(failure),
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
      await vi.waitFor(() => expect(errors.handleError).toHaveBeenCalled());
      for (const event of open.getLiveTimeline().getEvents()) {
        client.emit(MatrixEventEvent.Decrypted, event);
      }

      expect(open.getLiveTimeline().getEvents()).toHaveLength(5);
      expect(open.getUnreadNotificationCount(NotificationCountType.Total)).toBe(
        20,
      );
      decryptionDone();
    });
  });
});
