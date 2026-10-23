import {
  ConnectionError,
  EventStatus,
  EventType,
  MsgType,
  RelationType,
  type MatrixEvent,
} from 'matrix-js-sdk';

/** Media echoes are left out: the media pipeline owns them. */
const RESENDABLE: ReadonlySet<unknown> = new Set([
  MsgType.Text,
  MsgType.Emote,
  MsgType.Notice,
]);

/**
 * Whether a local echo is a text, emote or notice that failed only because the homeserver
 * could not be reached, so it can go out by itself once sync reconnects. matrix-js-sdk never
 * resends it on its own. An edit, or a send the server refused, keeps the manual Retry.
 */
export function isWaitingToSend(event: MatrixEvent): boolean {
  return (
    event.status === EventStatus.NOT_SENT &&
    event.error instanceof ConnectionError &&
    event.getType() === EventType.RoomMessage &&
    RESENDABLE.has(event.getContent().msgtype) &&
    !event.isRelation(RelationType.Replace)
  );
}
