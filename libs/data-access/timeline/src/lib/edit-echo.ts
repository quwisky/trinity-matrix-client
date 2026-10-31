import { EventStatus, type MatrixClient, type Room } from 'matrix-js-sdk';

/**
 * `send` for an edit of `messageId` under `txnId`, leaving the message on what the server accepted
 * when it fails: the SDK keeps a failed edit attached to its message. Only that send's echo is
 * cancelled, and only while NOT_SENT: a rejected send always ends there, and a landed one must
 * stay. On the promise, so that closing the view mid-send still drops the echo.
 */
export function sendEdit<T>(
  client: MatrixClient,
  room: Room,
  messageId: string,
  txnId: string,
  send: () => Promise<T>,
): Promise<T> {
  // An edit known only as bundled on the message is in no Relations, so once an echo is cancelled
  // the SDK's re-aggregation would otherwise fall back to the message's original text.
  const accepted = room.findEventById(messageId)?.replacingEvent();
  if (accepted && !accepted.status) {
    room.relations.aggregateChildEvent(accepted);
  }
  return send().catch((error: unknown) => {
    const echo = room.getEventForTxnId(txnId);
    if (echo?.status === EventStatus.NOT_SENT) client.cancelPendingEvent(echo);
    throw error;
  });
}
