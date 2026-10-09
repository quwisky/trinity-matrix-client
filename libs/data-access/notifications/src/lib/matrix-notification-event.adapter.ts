import type { MatrixEvent, Room } from 'matrix-js-sdk';
import type { NotificationEvent } from './notification-intent';

/**
 * Narrow one SDK event into the value-only record consumed by Notifications policy.
 * `roomEncrypted` is whether the room counts as encrypted (see `RoomEncryptionFlags`).
 */
export function normalizeNotificationEvent(
  accountId: string,
  event: MatrixEvent,
  room: Room,
  roomEncrypted: boolean,
): NotificationEvent {
  const senderId = event.getSender() ?? '';
  const senderName = event.sender?.name ?? (senderId || 'Someone');
  const content = event.getContent();
  const rawBody = content?.['body'];
  // Text that arrived in the clear in an encrypted room is not previewed: the
  // notification falls back to the generic "New message".
  const previewable =
    typeof rawBody === 'string' && (event.isEncrypted() || !roomEncrypted);
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
