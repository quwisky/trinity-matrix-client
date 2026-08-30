import type { MatrixEvent, Room } from 'matrix-js-sdk';
import type { NotificationEvent } from './notification-intent';

/** Narrow one SDK event into the value-only record consumed by Notifications policy. */
export function normalizeNotificationEvent(
  accountId: string,
  event: MatrixEvent,
  room: Room,
): NotificationEvent {
  const senderId = event.getSender() ?? '';
  const senderName = event.sender?.name ?? (senderId || 'Someone');
  const content = event.getContent();
  const rawBody = content?.['body'];
  return Object.freeze({
    accountId,
    roomId: room.roomId,
    eventId: event.getId() ?? '',
    senderId,
    senderName,
    roomName: room.name || null,
    body: typeof rawBody === 'string' ? rawBody : null,
    kind: typeof rawBody === 'string' ? 'message' : 'unsupported',
  });
}
