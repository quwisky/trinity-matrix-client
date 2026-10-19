import {
  EventTimeline,
  EventType,
  THREAD_RELATION_TYPE,
  type EventTimelineSet,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';

/**
 * The fewest events a trim leaves in a room's live timeline: what a restart restores from
 * the sync store, and enough to fill the first screen when the room is opened again.
 */
export const TRIM_KEEP = 50;

/**
 * How many events a room nobody has open may hold before it is trimmed; also the open
 * room's, while the window is hidden and its view follows the newest message. Each event
 * costs about 2 KB of heap, so a trimmable room stays under roughly 0.4 MB.
 *
 * A trim never cuts past the person's read receipt or fully-read marker, so a room that
 * keeps receiving events after it was last read can grow past this until
 * {@link TRIM_CEILING}.
 */
export const TRIM_HIGH_WATER = 200;

/**
 * How many events a room nobody has open may hold before its read receipt and fully-read
 * marker stop protecting the events after them, about 2 MB. The room is then trimmed to
 * its latest events like any other. Unread counts live on the room and stay; what goes is
 * the "New messages" divider when the room is opened again, as after a restart.
 *
 * In an encrypted room, re-fetched events decrypt again, and the SDK counts those after a
 * receipt it does not have loaded as unread a second time. That needs the room opened
 * while the window has no focus, since `TimelineService.markRead` holds the receipt until
 * then, and scrolled back past the kept events; focusing re-acks and the next sync resets
 * the count. It also happens below this ceiling when the receipt was not loaded.
 */
export const TRIM_CEILING = 1_000;

/**
 * A place a live timeline can be cut: the events after it stay, and `token` pages back from
 * just before them. The SDK keeps a back token only for the start of a timeline, so every
 * cut point is recorded while that start, or the sync position, is known.
 */
interface Cut {
  /** The event at, or just before, the cut. */
  readonly eventId: string;
  /** True when the event itself stays: the cut is just before it. */
  readonly keepsEvent: boolean;
  readonly token: string;
}

const cuts = new WeakMap<EventTimeline, Cut[]>();

function cutsOf(timeline: EventTimeline): Cut[] {
  let found = cuts.get(timeline);
  if (!found) {
    found = [];
    cuts.set(timeline, found);
  }
  return found;
}

const isPending = (event: MatrixEvent): boolean => event.status !== null;

/**
 * Record that `token` pages back from just before the live timeline's first event. Called
 * as each page of history is requested, so every page boundary is a place to cut.
 */
export function noteScrollbackPosition(
  timeline: EventTimeline,
  token: string,
): void {
  const first = timeline.getEvents()[0];
  const eventId = first?.getId();
  if (!first || !eventId || isPending(first)) return;
  cutsOf(timeline).push({ eventId, keepsEvent: true, token });
}

/**
 * Record a sync position: `syncToken` (a `next_batch`, which `/messages` accepts as `from`)
 * pages back from the end of everything this room has received. Recorded once the room has
 * received {@link TRIM_KEEP} events since its last one, so live events can be trimmed too.
 *
 * Only events before the first local echo count: an echo is not on the server until a
 * later sync, so it may sit after the token.
 */
export function noteSyncPosition(room: Room, syncToken: string): void {
  const timeline = room.getLiveTimeline();
  const events = timeline.getEvents();
  const firstPending = events.findIndex(isPending);
  const last = (firstPending === -1 ? events.length : firstPending) - 1;
  const eventId = events[last]?.getId();
  if (!eventId) return;
  const recorded = cutsOf(timeline);
  let previous: Cut | undefined;
  for (let i = recorded.length - 1; i >= 0 && !previous; i--) {
    if (!recorded[i].keepsEvent) previous = recorded[i];
  }
  if (previous) {
    if (previous.eventId === eventId) return;
    const since = last - indexOf(events, previous.eventId, last);
    if (since < TRIM_KEEP) return;
  }
  recorded.push({ eventId, keepsEvent: false, token: syncToken });
}

/** Index of `eventId` at or before `from`, searching backwards; -1 when absent. */
function indexOf(
  events: readonly MatrixEvent[],
  eventId: string,
  from: number,
): number {
  for (let i = from; i >= 0; i--) {
    if (events[i].getId() === eventId) return i;
  }
  return -1;
}

/**
 * Events a caller needs kept beyond what the room itself protects: the open room's view
 * and composer. Ids that are null or not loaded are ignored.
 */
export interface TrimGuard {
  /**
   * Kept like the read receipt: only while the room holds at most {@link TRIM_CEILING}
   * events. For the open room's divider position, quoted messages and thread root.
   */
  readonly marked?: readonly (string | null | undefined)[];
  /** Never cut, past the ceiling too: what the view shows, or the composer's target. */
  readonly kept?: readonly (string | null | undefined)[];
}

/**
 * The furthest a trim may cut and still change nothing the app reads from the timeline:
 * the room list's latest message, the person's read receipt and fully-read marker (below
 * {@link TRIM_CEILING}), what the caller's {@link TrimGuard} names, any local echo still
 * being sent or retried, and the target of every kept reaction, edit or redaction. The
 * SDK keeps a relation out of the main timeline while its target is missing, so cutting
 * between them would drop the relation, and with it maybe the room's latest event.
 */
function cutLimit(
  room: Room,
  userId: string,
  events: readonly MatrixEvent[],
  indexById: ReadonlyMap<string, number>,
  guard: TrimGuard,
): number {
  const protectedIds: unknown[] = [...(guard.kept ?? [])];
  if (events.length <= TRIM_CEILING) {
    protectedIds.push(
      room.getEventReadUpTo(userId, false),
      room.getEventReadUpTo(userId, true),
      room.getAccountData(EventType.FullyRead)?.getContent()['event_id'],
      ...(guard.marked ?? []),
    );
  }
  let limit = events.length - TRIM_KEEP;
  for (const eventId of protectedIds) {
    const index =
      typeof eventId === 'string' ? indexById.get(eventId) : undefined;
    if (index !== undefined) limit = Math.min(limit, index);
  }
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].getType() === EventType.RoomMessage) {
      limit = Math.min(limit, i);
      break;
    }
  }
  const firstPending = events.findIndex(isPending);
  if (firstPending !== -1) limit = Math.min(limit, firstPending);
  // Moving the limit back keeps more events, whose own targets may lie further back.
  for (let i = events.length - 1; i >= limit; i--) {
    const target = targetOf(events[i]);
    const index = target === undefined ? undefined : indexById.get(target);
    if (index !== undefined && index < limit) limit = index;
  }
  return limit;
}

/** The event a relation (other than a thread reply) or a redaction applies to. */
function targetOf(event: MatrixEvent): string | undefined {
  if (event.isRedaction()) return event.getAssociatedId();
  const relation = event.getRelation();
  return relation?.rel_type && relation.rel_type !== THREAD_RELATION_TYPE.name
    ? relation.event_id
    : undefined;
}

/**
 * Trim a room's SDK live timeline back to its latest events, so history that was paged in
 * or received is freed and is fetched again with `/messages` when the room is scrolled back.
 *
 * Call for a room nobody has open, or for the open room with a {@link TrimGuard} naming
 * what its view and composer need. The room keeps at least {@link TRIM_KEEP} events,
 * cut at a recorded page boundary or sync position so the new back token lands at or after
 * the first kept event: no gap when it is paged back again, and the SDK drops by event id
 * any kept event a page brings again. Only the main timeline is replaced, never the thread
 * timelines, and the kept events are the same objects. Unread counts, receipts and
 * relations live on the room and are untouched.
 *
 * Returns the number of events dropped: 0 when there was no safe place to cut.
 */
export function trimLiveTimeline(
  room: Room,
  userId: string,
  guard: TrimGuard = {},
): number {
  const timelineSet = room.getUnfilteredTimelineSet();
  const live = timelineSet.getLiveTimeline();
  const events = live.getEvents();
  const recorded = cuts.get(live);
  if (events.length <= TRIM_KEEP || !recorded?.length) return 0;
  const indexById = new Map<string, number>();
  events.forEach((event, i) => {
    const eventId = event.getId();
    if (eventId) indexById.set(eventId, i);
  });
  const limit = cutLimit(room, userId, events, indexById, guard);
  let chosen: { index: number; cut: Cut } | null = null;
  for (const cut of recorded) {
    const at = indexById.get(cut.eventId);
    if (at === undefined) continue;
    const index = cut.keepsEvent ? at : at + 1;
    if (index > (chosen?.index ?? 0) && index <= limit) chosen = { index, cut };
  }
  if (!chosen) return 0;
  const { index, cut: used } = chosen;
  const stillValid = recorded.filter(
    (cut) => cut !== used && (indexById.get(cut.eventId) ?? -1) >= index,
  );
  try {
    rebase(room, timelineSet, events.slice(index), used.token);
  } finally {
    if (timelineSet.getLiveTimeline() !== live) {
      cuts.set(timelineSet.getLiveTimeline(), stillValid);
    }
  }
  return index;
}

/**
 * Empty a room's live timeline but for its local echoes, so it pages back in from
 * `syncToken` (a `next_batch`): what the server now sends, such as the messages of a person
 * it left out while they were blocked. Like a trim, it leaves threads, unread counts and
 * receipts alone.
 */
export function rewindLiveTimeline(room: Room, syncToken: string): void {
  const timelineSet = room.getUnfilteredTimelineSet();
  const pending = timelineSet.getLiveTimeline().getEvents().filter(isPending);
  rebase(room, timelineSet, pending, syncToken);
}

/**
 * Replace the live timeline with one holding only `kept`, paging back from `token`: what
 * the SDK does on a gappy sync, except that the kept events (the same objects) carry over.
 *
 * The SDK emits to listeners synchronously as it swaps the timeline and adds each event.
 * One that throws must not cost the room its newest events, which nothing could page back
 * in, so every step runs and the first failure is rethrown once the timeline is whole.
 */
function rebase(
  room: Room,
  timelineSet: EventTimelineSet,
  kept: readonly MatrixEvent[],
  token: string,
): void {
  const failures: unknown[] = [];
  const attempt = (step: () => void): void => {
    try {
      step();
    } catch (error: unknown) {
      failures.push(error);
    }
  };
  const previous = timelineSet.getLiveTimeline();
  attempt(() => timelineSet.resetLiveTimeline(token));
  const fresh = timelineSet.getLiveTimeline();
  // The swap itself failed: nothing has changed.
  if (fresh === previous) throw failures[0];
  // Oldest first, so each relation finds its target already back in the timeline. As in
  // a restore from the sync store, they are not live events: nothing notifies for them.
  for (const event of kept) {
    attempt(() =>
      timelineSet.addEventToTimeline(event, fresh, {
        toStartOfTimeline: false,
        fromCache: true,
        addToState: false,
      }),
    );
  }
  // The room's current state already holds the kept state events. Wind the new start
  // state back over them, as paging them in would, so later pages get the senders and
  // state of their own time. Each event is backward-looking only while it is applied:
  // the current state still reads it forwards. That makes the start state approximate:
  // names and membership come out as of the cut, but power levels and avatars, which the
  // SDK reads lazily from the event, read forwards, so rows paged back in may show the
  // current ones.
  const start = fresh.getState(EventTimeline.BACKWARDS);
  for (let i = kept.length - 1; i >= 0; i--) {
    const event = kept[i];
    if (!event.isState() || !start) continue;
    const forwardLooking = event.forwardLooking;
    event.forwardLooking = false;
    attempt(() => start.setStateEvents([event]));
    event.forwardLooking = forwardLooking;
  }
  // `Room.resetLiveTimeline` would also reset every thread's timeline, so only the main
  // timeline set is reset and the room's `oldState` is repointed at its new start. The SDK
  // keeps this method private; if a release renames it, the `oldState` assertion in
  // live-timeline-trim.spec.ts ("changes no unread count, receipt, relation or summary
  // the room list reads") fails.
  attempt(() =>
    (room as unknown as LegacyTimelineFields).fixUpLegacyTimelineFields?.(),
  );
  if (failures.length > 0) throw failures[0];
}

interface LegacyTimelineFields {
  fixUpLegacyTimelineFields?: () => void;
}
