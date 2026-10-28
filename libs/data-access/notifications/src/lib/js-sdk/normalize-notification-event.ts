import type { MatrixEvent, Room } from 'matrix-js-sdk';
import { displayContent, validReplacement } from '@trinity/util/matrix';
import type { IncomingNotification } from '../notification-engine';

/**
 * Narrow one SDK event into the value-only record consumed by Notifications policy.
 * `roomEncrypted` is whether the room counts as encrypted (see `RoomEncryptionFlags`).
 */
export function normalizeNotificationEvent(
  accountId: string,
  event: MatrixEvent,
  room: Room,
  roomEncrypted: boolean,
): IncomingNotification {
  const senderId = event.getSender() ?? '';
  const senderName = event.sender?.name ?? (senderId || 'Someone');
  const content = displayContent(event);
  const rawBody = content?.['body'];
  // Text that arrived in the clear in an encrypted room is not previewed: the
  // notification falls back to the generic "New message". The text shown is the edit's
  // when there is one, so it is the edit that must have been encrypted.
  const shown = validReplacement(event) ?? event;
  const previewable =
    typeof rawBody === 'string' && (shown.isEncrypted() || !roomEncrypted);
  return Object.freeze({
    accountId,
    roomId: room.roomId,
    eventId: event.getId() ?? '',
    senderId,
    senderName,
    roomName: room.name || null,
    body: previewable ? rawBody : null,
    kind: typeof rawBody === 'string' ? 'message' : 'unsupported',
  });
}
