import {
  EventTimeline,
  EventType,
  RoomEvent,
  type IRoomTimelineData,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';

/**
 * Moves a room's membership forward when a live timeline `m.room.member` event replaces exactly
 * the event its state still holds. Synapse can send a `state_after` that lags the same response's
 * timeline (Bob's join beside his invite); the SDK applies only `state_after`, so in a
 * members-only room the next message's key skips him (#1986). A state that has moved on to any
 * other event is kept. Returns the call that stops listening.
 *
 * `replaces_state` is set by our own homeserver, which also writes `state_after`, so this trusts
 * the server no more than the SDK already does. A join from a fork that state resolution
 * overruled could still be applied, as the SDK did before MSC4222. `liveEvent` is deliberately
 * not checked: a replay from the sync cache brings back the stale state and needs the repair too.
 */
export function repairStaleMembership(client: MatrixClient): () => void {
  const onTimeline = (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined,
    _removed: boolean,
    data: IRoomTimelineData,
  ): void => {
    const userId = event.getStateKey();
    if (
      !room ||
      toStartOfTimeline ||
      data.timeline !== room.getLiveTimeline() ||
      event.getType() !== EventType.RoomMember ||
      userId === undefined
    ) {
      return;
    }
    const state = data.timeline.getState(EventTimeline.FORWARDS);
    const replaced = event.getUnsigned().replaces_state;
    if (
      replaced &&
      state?.getStateEvents(EventType.RoomMember, userId)?.getId() === replaced
    ) {
      state.setStateEvents([event]);
    }
  };
  client.on(RoomEvent.Timeline, onTimeline);
  return () => client.off(RoomEvent.Timeline, onTimeline);
}
