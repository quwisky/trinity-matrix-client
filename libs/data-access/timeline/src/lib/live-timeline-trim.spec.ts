import {
  Direction,
  EventStatus,
  EventType,
  MatrixEvent,
  NotificationCountType,
  RelationType,
  Room,
  RoomEvent,
  createClient,
  type IRoomEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { scrollbackLive } from './js-sdk/live-scrollback';
import {
  TRIM_CEILING,
  TRIM_KEEP,
  noteSyncPosition,
  rewindLiveTimeline,
  trimLiveTimeline,
} from './live-timeline-trim';

type IMessagesResponse = Awaited<
  ReturnType<MatrixClient['createMessagesRequest']>
>;

const ME = '@me:hs';
const ROOM = '!r:hs';
const PAGE = 30;

/** `$<n>` is the room's n-th event; `b<n>` pages back from just before it. */
const id = (n: number) => `$${n}`;
const before = (n: number) => `b${n}`;

function raw(
  n: number,
  overrides: Partial<IRoomEvent> & {
    state_key?: string;
    redacts?: string;
  } = {},
): IRoomEvent {
  return {
    event_id: id(n),
    room_id: ROOM,
    type: 'm.room.message',
    sender: '@a:hs',
    origin_server_ts: n,
    content: { msgtype: 'm.text', body: `message ${n}` },
    unsigned: {},
    ...overrides,
  };
}

/**
 * A real SDK client and Room in front of a homeserver that holds `history` events. The
 * trim swaps the SDK's live timeline under every reader, which a fake would only restate.
 */
function setup(history: number, rawEvent: (n: number) => IRoomEvent = raw) {
  const client = createClient({
    baseUrl: 'https://hs',
    userId: ME,
    fetchFn: () => Promise.reject(new Error('no network in unit tests')),
  });
  // As Trinity starts it: thread replies live in their thread's timeline.
  vi.spyOn(client, 'supportsThreads').mockReturnValue(true);
  const room = new Room(ROOM, client, ME);
  const request = vi
    .spyOn(client, 'createMessagesRequest')
    .mockImplementation(async (_roomId, from, limit) => {
      const position = Number(String(from).slice(1));
      const oldest = Math.max(1, position - (limit ?? PAGE));
      const chunk: IRoomEvent[] = [];
      for (let n = position - 1; n >= oldest; n--) chunk.push(rawEvent(n));
      const res: IMessagesResponse = {
        chunk,
        start: String(from),
        end: chunk.length === 0 ? undefined : before(oldest),
      };
      return res;
    });
  return { client, room, request };
}

/** What a sync delivers: events `from..to` appended to the live timeline. */
async function receive(
  room: Room,
  from: number,
  to: number,
  rawEvent: (n: number) => IRoomEvent = raw,
): Promise<void> {
  const events: MatrixEvent[] = [];
  for (let n = from; n <= to; n++) events.push(new MatrixEvent(rawEvent(n)));
  await room.addLiveEvents(events, { addToState: true });
}

/** The live timeline as started by a sync: `from..to`, paging back from `$from`. */
async function startedAt(room: Room, from: number, to: number) {
  room.getLiveTimeline().setPaginationToken(before(from), Direction.Backward);
  await receive(room, from, to);
}

const ids = (room: Room) =>
  room
    .getLiveTimeline()
    .getEvents()
    .map((e) => e.getId());

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => id(from + i));

async function pageToStart(client: MatrixClient, room: Room): Promise<void> {
  while (
    room.getLiveTimeline().getPaginationToken(Direction.Backward) !== null
  ) {
    await scrollbackLive(client, room, PAGE);
  }
}

describe('trimLiveTimeline', () => {
  it('trims scrolled-back history to the latest events and re-fetches it without gaps', async () => {
    const { client, room } = setup(330);
    await startedAt(room, 311, 330);
    await pageToStart(client, room);
    expect(ids(room)).toEqual(range(1, 330));
    const latest = room.getLiveTimeline().getEvents().slice(-TRIM_KEEP);

    const dropped = trimLiveTimeline(room, ME);

    const kept = ids(room);
    expect(dropped).toBe(330 - kept.length);
    expect(kept.length).toBeGreaterThanOrEqual(TRIM_KEEP);
    expect(kept.length).toBeLessThan(TRIM_KEEP + PAGE);
    expect(kept).toEqual(range(331 - kept.length, 330));
    expect(room.getLiveTimeline().getEvents().slice(-TRIM_KEEP)).toEqual(
      latest,
    );
    expect(room.findEventById(id(1))).toBeUndefined();
    expect(room.getLiveTimeline().getPaginationToken(Direction.Backward)).toBe(
      before(331 - kept.length),
    );

    await pageToStart(client, room);

    expect(ids(room)).toEqual(range(1, 330));
  });

  it('trims events received live back to a sync position and re-fetches them without gaps', async () => {
    const { client, room } = setup(400);
    await startedAt(room, 101, 120);
    noteSyncPosition(room, before(121));
    for (let last = 120; last < 400; last += 10) {
      await receive(room, last + 1, last + 10);
      noteSyncPosition(room, before(last + 11));
    }

    trimLiveTimeline(room, ME);

    const kept = ids(room);
    expect(kept.length).toBeGreaterThanOrEqual(TRIM_KEEP);
    expect(kept.length).toBeLessThanOrEqual(2 * TRIM_KEEP + 10);
    expect(kept).toEqual(range(401 - kept.length, 400));

    await pageToStart(client, room);

    expect(ids(room)).toEqual(range(1, 400));
  });

  it.each([
    ['the reset', RoomEvent.TimelineReset],
    ['a kept event', RoomEvent.Timeline],
  ] as const)(
    'keeps every kept event when a listener throws on %s',
    async (_, emitted) => {
      const { client, room } = setup(330);
      await startedAt(room, 311, 330);
      await pageToStart(client, room);
      const failure = new Error('listener failed');
      let calls = 0;
      room.on(emitted, () => {
        if (++calls === 3 || emitted === RoomEvent.TimelineReset) throw failure;
      });

      expect(() => trimLiveTimeline(room, ME)).toThrow(failure);

      const kept = ids(room);
      expect(kept.length).toBeGreaterThanOrEqual(TRIM_KEEP);
      expect(kept).toEqual(range(331 - kept.length, 330));
      expect(room.oldState).toBe(
        room.getLiveTimeline().getState(Direction.Backward),
      );

      await pageToStart(client, room);

      expect(ids(room)).toEqual(range(1, 330));
    },
  );

  it('leaves a timeline alone when it has no position to page back from', async () => {
    const { room } = setup(300);
    await startedAt(room, 1, 300);

    expect(trimLiveTimeline(room, ME)).toBe(0);
    expect(ids(room)).toEqual(range(1, 300));
  });

  it('keeps the latest events when there are only a few more than it keeps', async () => {
    const { client, room } = setup(80);
    await startedAt(room, 61, 80);
    await scrollbackLive(client, room, PAGE);

    expect(trimLiveTimeline(room, ME)).toBe(0);
    expect(ids(room)).toEqual(range(31, 80));
  });

  it('keeps the event the read receipt and the fully-read marker point at', async () => {
    const { client, room } = setup(330);
    await startedAt(room, 311, 330);
    await pageToStart(client, room);
    room.addReceipt(
      new MatrixEvent({
        type: EventType.Receipt,
        room_id: ROOM,
        content: { [id(200)]: { 'm.read': { [ME]: { ts: 1 } } } },
      }),
    );
    room.addAccountData([
      new MatrixEvent({
        type: EventType.FullyRead,
        room_id: ROOM,
        content: { event_id: id(150) },
      }),
    ]);

    trimLiveTimeline(room, ME);

    expect(room.findEventById(id(150))).toBeDefined();
    expect(room.getEventReadUpTo(ME)).toBe(id(200));
    expect(ids(room).length).toBeLessThan(330 - 120);
  });

  it('trims past the read receipt and fully-read marker once a room passes the ceiling', async () => {
    const last = TRIM_CEILING + 200;
    const { client, room } = setup(last);
    await startedAt(room, 101, 120);
    noteSyncPosition(room, before(121));
    room.addReceipt(
      new MatrixEvent({
        type: EventType.Receipt,
        room_id: ROOM,
        content: { [id(110)]: { 'm.read': { [ME]: { ts: 110 } } } },
      }),
    );
    room.addAccountData([
      new MatrixEvent({
        type: EventType.FullyRead,
        room_id: ROOM,
        content: { event_id: id(110) },
      }),
    ]);
    // Received while nobody reads the room: everything after the receipt is unread.
    for (let at = 120; at < last; at += 10) {
      await receive(room, at + 1, at + 10);
      noteSyncPosition(room, before(at + 11));
    }
    room.setUnreadNotificationCount(NotificationCountType.Total, last - 110);
    room.setUnreadNotificationCount(NotificationCountType.Highlight, 3);
    expect(room.getLiveTimeline().getEvents().length).toBeGreaterThan(
      TRIM_CEILING,
    );

    trimLiveTimeline(room, ME);

    const kept = ids(room);
    expect(kept.length).toBeGreaterThanOrEqual(TRIM_KEEP);
    expect(kept.length).toBeLessThanOrEqual(2 * TRIM_KEEP + 10);
    expect(kept).toEqual(range(last + 1 - kept.length, last));
    expect(room.getUnreadNotificationCount(NotificationCountType.Total)).toBe(
      last - 110,
    );
    expect(
      room.getUnreadNotificationCount(NotificationCountType.Highlight),
    ).toBe(3);
    // The receipt stays recorded; the SDK ignores it while its event is not loaded, as
    // after a restart.
    expect(room.getReadReceiptForUserId(ME)?.eventId).toBe(id(110));
    // A kept event stays unread, as the encrypted-room count needs when it decrypts.
    expect(room.hasUserReadEvent(ME, id(last))).toBe(false);

    await pageToStart(client, room);

    expect(ids(room)).toEqual(range(1, last));
  });

  it('keeps the read receipt below the ceiling', async () => {
    const last = TRIM_CEILING - 100;
    const { room } = setup(last);
    await startedAt(room, 101, 120);
    noteSyncPosition(room, before(121));
    room.addReceipt(
      new MatrixEvent({
        type: EventType.Receipt,
        room_id: ROOM,
        content: { [id(110)]: { 'm.read': { [ME]: { ts: 110 } } } },
      }),
    );
    for (let at = 120; at < last; at += 10) {
      await receive(room, at + 1, at + 10);
      noteSyncPosition(room, before(at + 11));
    }

    expect(trimLiveTimeline(room, ME)).toBe(0);
    expect(room.findEventById(id(110))).toBeDefined();
  });

  it('keeps an event the caller marks as read up to, below the ceiling', async () => {
    const { client, room } = setup(330);
    await startedAt(room, 311, 330);
    await pageToStart(client, room);

    trimLiveTimeline(room, ME, { marked: [id(150), null] });

    // The page boundary just before it.
    expect(ids(room)).toEqual(range(131, 330));
  });

  it('trims past an event the caller marks once the room passes the ceiling', async () => {
    const last = TRIM_CEILING + 200;
    const { room } = setup(last);
    await startedAt(room, 101, 120);
    noteSyncPosition(room, before(121));
    for (let at = 120; at < last; at += 10) {
      await receive(room, at + 1, at + 10);
      noteSyncPosition(room, before(at + 11));
    }

    trimLiveTimeline(room, ME, { marked: [id(110)] });

    expect(room.findEventById(id(110))).toBeUndefined();
    expect(ids(room).length).toBeLessThanOrEqual(2 * TRIM_KEEP + 10);
  });

  it('keeps an event the caller must keep, past the ceiling too', async () => {
    const last = TRIM_CEILING + 200;
    const { room } = setup(last);
    await startedAt(room, 101, 120);
    noteSyncPosition(room, before(121));
    for (let at = 120; at < last; at += 10) {
      await receive(room, at + 1, at + 10);
      noteSyncPosition(room, before(at + 11));
    }

    const dropped = trimLiveTimeline(room, ME, { kept: [id(905), '$absent'] });

    expect(dropped).toBeGreaterThan(0);
    // The sync position just before it.
    expect(ids(room)).toEqual(range(871, last));
  });

  it('keeps the latest message the room list previews', async () => {
    const notice = (n: number): IRoomEvent =>
      n > 200
        ? raw(n, {
            type: 'm.room.topic',
            state_key: '',
            content: { topic: `topic ${n}` },
          })
        : raw(n);
    const { client, room } = setup(330, notice);
    room.getLiveTimeline().setPaginationToken(before(311), Direction.Backward);
    await receive(room, 311, 330, notice);
    await pageToStart(client, room);

    trimLiveTimeline(room, ME);

    const events = room.getLiveTimeline().getEvents();
    const latestMessage = [...events]
      .reverse()
      .find((e) => e.getType() === EventType.RoomMessage);
    expect(latestMessage?.getId()).toBe(id(200));
  });

  it('keeps the message a recent reaction or redaction applies to', async () => {
    const relation = (n: number): IRoomEvent =>
      n === 331
        ? raw(n, {
            type: EventType.Reaction,
            content: {
              'm.relates_to': {
                rel_type: RelationType.Annotation,
                event_id: id(120),
                key: '👍',
              },
            },
          })
        : raw(n, { type: EventType.RoomRedaction, redacts: id(90) });
    const { client, room } = setup(330);
    await startedAt(room, 311, 330);
    await pageToStart(client, room);
    await receive(room, 331, 332, relation);
    expect(room.findEventById(id(331))).toBeDefined();
    expect(room.findEventById(id(332))).toBeDefined();

    trimLiveTimeline(room, ME);

    expect(ids(room)).toEqual(range(71, 332));
  });

  it('keeps a message that is still being sent, and everything after it', async () => {
    const { client, room } = setup(330);
    await startedAt(room, 311, 330);
    await pageToStart(client, room);
    const echo = new MatrixEvent({
      ...raw(0),
      event_id: '~local',
      sender: ME,
    });
    echo.setStatus(EventStatus.SENDING);
    room.addPendingEvent(echo, 'txn');
    const pending = room.getLiveTimeline().getEvents().indexOf(echo);
    expect(pending).toBe(330);

    trimLiveTimeline(room, ME);

    expect(room.getLiveTimeline().getEvents().at(-1)).toBe(echo);
    expect(room.findEventById('~local')).toBe(echo);
  });

  it('changes no unread count, receipt, relation or summary the room list reads', async () => {
    const { client, room } = setup(330);
    await startedAt(room, 311, 330);
    await pageToStart(client, room);
    await receive(room, 331, 331, (n) =>
      raw(n, {
        type: EventType.Reaction,
        content: {
          'm.relates_to': {
            rel_type: RelationType.Annotation,
            event_id: id(320),
            key: '👍',
          },
        },
      }),
    );
    room.setUnreadNotificationCount(NotificationCountType.Total, 7);
    room.setUnreadNotificationCount(NotificationCountType.Highlight, 2);
    room.addReceipt(
      new MatrixEvent({
        type: EventType.Receipt,
        room_id: ROOM,
        content: { [id(325)]: { 'm.read': { [ME]: { ts: 1 } } } },
      }),
    );
    const currentState = room.currentState;
    const snapshot = () => ({
      total: room.getUnreadNotificationCount(NotificationCountType.Total),
      highlight: room.getUnreadNotificationCount(
        NotificationCountType.Highlight,
      ),
      readUpTo: room.getEventReadUpTo(ME),
      hasRead: room.hasUserReadEvent(ME, id(325)),
      lastActive: room.getLastActiveTimestamp(),
      lastEvent: room.getLiveTimeline().getEvents().at(-1)?.getId(),
      reactions: room.relations
        .getChildEventsForEvent(
          id(320),
          RelationType.Annotation,
          EventType.Reaction,
        )
        ?.getRelations()
        .map((e) => e.getId()),
    });
    const before = snapshot();

    trimLiveTimeline(room, ME);

    expect(snapshot()).toEqual(before);
    expect(room.currentState).toBe(currentState);
    expect(
      room
        .getLiveTimeline()
        .getEvents()
        .every((event) => event.forwardLooking),
    ).toBe(true);
    expect(room.oldState).toBe(
      room.getLiveTimeline().getState(Direction.Backward),
    );
  });

  it('leaves thread summaries alone', async () => {
    const { client, room } = setup(330);
    await startedAt(room, 311, 330);
    await pageToStart(client, room);
    const root = room.findEventById(id(10))!;
    const reply = new MatrixEvent({
      ...raw(1000),
      content: {
        msgtype: 'm.text',
        body: 'reply',
        'm.relates_to': { rel_type: RelationType.Thread, event_id: id(10) },
      },
    });
    const thread = room.createThread(id(10), root, [reply], false);
    const summary = () =>
      room.getThreads().map((t) => ({
        id: t.id,
        root: t.rootEvent?.getId(),
        length: t.length,
        events: t.events.map((e) => e.getId()),
      }));
    const before = summary();
    expect(before[0].events).toContain(id(1000));

    trimLiveTimeline(room, ME);

    expect(
      room.getUnfilteredTimelineSet().findEventById(id(10)),
    ).toBeUndefined();
    expect(room.getThread(id(10))).toBe(thread);
    expect(summary()).toEqual(before);
  });
});

describe('rewindLiveTimeline', () => {
  it('empties the live timeline but for local echoes, to page it back in from a sync position', async () => {
    const { client, room } = setup(330);
    // The server left out $325 while its sender was blocked.
    await startedAt(room, 311, 324);
    await receive(room, 326, 330);
    const echo = new MatrixEvent({ ...raw(0), event_id: '~local', sender: ME });
    echo.setStatus(EventStatus.SENDING);
    room.addPendingEvent(echo, 'txn');
    room.setUnreadNotificationCount(NotificationCountType.Total, 7);
    room.addReceipt(
      new MatrixEvent({
        type: EventType.Receipt,
        room_id: ROOM,
        content: { [id(320)]: { 'm.read': { [ME]: { ts: 1 } } } },
      }),
    );
    const snapshot = () => ({
      total: room.getUnreadNotificationCount(NotificationCountType.Total),
      receipt: room.getReadReceiptForUserId(ME)?.eventId,
    });
    const unchanged = snapshot();

    rewindLiveTimeline(room, before(331));

    expect(room.getLiveTimeline().getEvents()).toEqual([echo]);
    expect(room.getLiveTimeline().getPaginationToken(Direction.Backward)).toBe(
      before(331),
    );
    expect(snapshot()).toEqual(unchanged);
    expect(room.oldState).toBe(
      room.getLiveTimeline().getState(Direction.Backward),
    );

    await scrollbackLive(client, room, PAGE);

    expect(ids(room)).toEqual([...range(301, 330), '~local']);
  });
});
