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
 * How many events a room nobody has open may hold before it is trimmed. Each event costs
 * about 2 KB of heap, so this bounds a busy room at roughly 0.4 MB however long it runs.
 */
export const TRIM_HIGH_WATER = 200;

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
 * The furthest a trim may cut and still change nothing the app reads from the timeline:
 * the room list's latest message, the person's read receipt and fully-read marker, any
 * local echo still being sent or retried, and the target of every kept reaction, edit or
 * redaction. The SDK keeps a relation out of the main timeline while its target is
 * missing, so cutting between them would drop the relation, and with it maybe the room's
 * latest event.
 */
function cutLimit(
  room: Room,
  userId: string,
  events: readonly MatrixEvent[],
  indexById: ReadonlyMap<string, number>,
): number {
  const protectedIds = [
    room.getEventReadUpTo(userId, false),
    room.getEventReadUpTo(userId, true),
    room.getAccountData(EventType.FullyRead)?.getContent()['event_id'],
  ];
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
 * Call only for a room nobody has open. The room keeps at least {@link TRIM_KEEP} events,
 * cut at a recorded page boundary or sync position so the new back token lands exactly
 * before the first kept event: no gap and no duplicate when it is paged back again. Only
 * the main timeline is replaced, never the thread timelines, and the kept events are the
 * same objects. Unread counts, receipts and relations live on the room and are untouched.
 *
 * Returns the number of events dropped: 0 when there was no safe place to cut.
 */
export function trimLiveTimeline(room: Room, userId: string): number {
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
  const limit = cutLimit(room, userId, events, indexById);
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
  rebase(room, timelineSet, events.slice(index), used.token);
  cuts.set(timelineSet.getLiveTimeline(), stillValid);
  return index;
}

/**
 * Replace the live timeline with one holding only `kept`, paging back from `token`: what
 * the SDK does on a gappy sync, except that the kept events (the same objects) carry over.
 */
function rebase(
  room: Room,
  timelineSet: EventTimelineSet,
  kept: readonly MatrixEvent[],
  token: string,
): void {
  timelineSet.resetLiveTimeline(token);
  const fresh = timelineSet.getLiveTimeline();
  // Oldest first, so each relation finds its target already back in the timeline. As in
  // a restore from the sync store, they are not live events: nothing notifies for them.
  for (const event of kept) {
    timelineSet.addEventToTimeline(event, fresh, {
      toStartOfTimeline: false,
      fromCache: true,
      addToState: false,
    });
  }
  // The room's current state already holds the kept state events. Wind the new start
  // state back over them, as paging them in would, so later pages get the senders and
  // state of their own time. Each event is backward-looking only while it is applied:
  // the current state still reads it forwards.
  const start = fresh.getState(EventTimeline.BACKWARDS);
  for (let i = kept.length - 1; i >= 0; i--) {
    const event = kept[i];
    if (!event.isState() || !start) continue;
    const forwardLooking = event.forwardLooking;
    event.forwardLooking = false;
    start.setStateEvents([event]);
    event.forwardLooking = forwardLooking;
  }
  // `Room.resetLiveTimeline` would also reset every thread's timeline, so only the main
  // timeline set is reset and the room's `oldState` is repointed at its new start.
  (room as unknown as LegacyTimelineFields).fixUpLegacyTimelineFields?.();
}

interface LegacyTimelineFields {
  fixUpLegacyTimelineFields?: () => void;
}
