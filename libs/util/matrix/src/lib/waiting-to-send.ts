import {
  ConnectionError,
  EventStatus,
  EventType,
  HTTPError,
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
 * Whether a send failed only for now: the homeserver could not be reached, or it rate-limited the
 * send. Without the SDK's scheduler nothing retries either on its own.
 */
export function isTemporarySendError(error: unknown): boolean {
  return (
    error instanceof ConnectionError ||
    (error instanceof HTTPError && error.isRateLimitError())
  );
}

/**
 * Whether a local echo is a text, emote or notice that failed only for now
 * ({@link isTemporarySendError}), so it can go out by itself once sync is back. matrix-js-sdk never
 * resends it on its own. An edit, or a send the server refused, keeps the manual Retry.
 */
export function isWaitingToSend(event: MatrixEvent): boolean {
  return (
    event.status === EventStatus.NOT_SENT &&
    isTemporarySendError(event.error) &&
    event.getType() === EventType.RoomMessage &&
    RESENDABLE.has(event.getContent().msgtype) &&
    !event.isRelation(RelationType.Replace)
  );
}
