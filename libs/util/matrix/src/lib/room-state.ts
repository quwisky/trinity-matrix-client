import { EventTimeline, type Room, type RoomState } from 'matrix-js-sdk';

/**
 * The room's live state — the state as of the newest event in its timeline.
 *
 * Use this instead of the deprecated `room.currentState`, a cached reference to exactly this
 * expression that is reassigned when the live timeline is replaced.
 *
 * Returns `undefined` when the live timeline has no forward state, which the SDK treats as
 * unreachable; take the conservative branch (deny a permission, report nothing pinned)
 * rather than assert. Never cache the result across an await or an event, or a timeline
 * reset leaves it stale.
 */
export function liveRoomState(room: Room): RoomState | undefined {
  return room.getLiveTimeline().getState(EventTimeline.FORWARDS);
}
