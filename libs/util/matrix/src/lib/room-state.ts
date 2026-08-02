import { EventTimeline, type Room, type RoomState } from 'matrix-js-sdk';

/**
 * The room's live state — the state as of the newest event in its timeline.
 *
 * Replaces the deprecated `room.currentState`, which the SDK keeps only as a cached
 * reference to exactly this expression ("more for backwards-compatibility than
 * anything else"), reassigned whenever the live timeline is replaced.
 *
 * Returns `undefined` when the live timeline has no forward state. The SDK treats that
 * as unreachable for a live timeline (its own assignment non-null-asserts it), so
 * callers should take the conservative branch — deny a permission, report nothing
 * pinned — rather than assert. Reading it fresh each time is also what makes a
 * timeline reset safe: never cache the result across an await or an event.
 */
export function liveRoomState(room: Room): RoomState | undefined {
  return room.getLiveTimeline().getState(EventTimeline.FORWARDS);
}
