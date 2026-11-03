import type {
  ISendEventResponse,
  MatrixClient,
  MatrixEvent,
  Room,
} from 'matrix-js-sdk';

/**
 * Sends a failed local echo again, first moving it to the end of the room's live timeline. The
 * SDK resends it where it was first added, yet the server stamps it with the time of the resend,
 * so a message retried at 11:09 would sit above one sent at 11:08.
 *
 * The raw timeline edit emits nothing: the re-render relies on `resendEvent`'s
 * `LocalEchoUpdated`. Only the main timeline is reordered; a thread echo resends in place.
 */
export function resendAtEnd(
  client: MatrixClient,
  event: MatrixEvent,
  room: Room,
): Promise<ISendEventResponse> {
  const live = room.getLiveTimeline();
  const id = event.getId();
  if (id && live.getEvents().at(-1) !== event && live.removeEvent(id)) {
    live.addEvent(event, { toStartOfTimeline: false, addToState: false });
  }
  return client.resendEvent(event, room);
}
