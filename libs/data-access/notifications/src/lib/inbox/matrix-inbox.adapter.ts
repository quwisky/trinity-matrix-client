import {
  Method,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import {
  parseNotificationsPage,
  type NotificationsPage,
} from './notifications-page';

export function fetchNotificationsPage(
  client: MatrixClient,
  from: string | null,
  limit: number,
): Promise<NotificationsPage> {
  // No `only` filter: the All tab needs every notification. The limit is a string, as in the SDK.
  const params: Record<string, string> = { limit: String(limit) };
  if (from !== null) params['from'] = from;
  return client.http
    .authedRequest<unknown>(Method.Get, '/notifications', params)
    .then(parseNotificationsPage);
}

export function mapInboxEvent(
  client: MatrixClient,
  raw: Readonly<Record<string, unknown>>,
  roomId: string,
): MatrixEvent {
  return client.getEventMapper({ preventReEmit: true, decrypt: false })({
    ...raw,
    room_id: roomId,
  } as Parameters<ReturnType<MatrixClient['getEventMapper']>>[0]);
}

export type IndexedEventLookup =
  | { readonly kind: 'found'; readonly event: MatrixEvent }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreachable' };

export async function lookUpIndexedEvent(
  client: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<IndexedEventLookup> {
  const known = client.getRoom(roomId)?.findEventById(eventId);
  if (known) return { kind: 'found', event: known };
  try {
    const raw = await client.fetchRoomEvent(roomId, eventId);
    if (raw.room_id && raw.room_id !== roomId) return { kind: 'gone' };
    return { kind: 'found', event: mapInboxEvent(client, raw, roomId) };
  } catch (error) {
    const status = (error as { httpStatus?: number } | null)?.httpStatus;
    return status === 403 || status === 404
      ? { kind: 'gone' }
      : { kind: 'unreachable' };
  }
}

export type InboxEventCheck =
  | { readonly kind: 'dropped' }
  | { readonly kind: 'undecryptable'; readonly event: MatrixEvent }
  | {
      readonly kind: 'checked';
      readonly event: MatrixEvent;
      readonly highlighted: boolean;
    };

/** Forcing a recalculation would overwrite the cached details the room's counts read. */
function isRoomsOwn(client: MatrixClient, event: MatrixEvent): boolean {
  const id = event.getId();
  return (
    id !== undefined &&
    client.getRoom(event.getRoomId() ?? '')?.findEventById(id) === event
  );
}

export async function checkInboxEvent(
  client: MatrixClient,
  event: MatrixEvent,
): Promise<InboxEventCheck> {
  if (event.isRedacted()) return { kind: 'dropped' };
  if (event.isEncrypted()) {
    if (event.getClearContent() === null && !client.getCrypto()) {
      return { kind: 'undecryptable', event };
    }
    try {
      await client.decryptEventIfNeeded(event);
    } catch {
      return { kind: 'undecryptable', event };
    }
    if (event.isDecryptionFailure() || event.getClearContent() === null) {
      return { kind: 'undecryptable', event };
    }
    if (event.isRedacted()) return { kind: 'dropped' };
  }
  // A legacy edit highlights by display name again, so it never counts. Own messages never do.
  const highlighted =
    event.getRelation()?.rel_type !== RelationType.Replace &&
    event.getSender() !== client.getUserId() &&
    client.getPushActionsForEvent(event, !isRoomsOwn(client, event))?.tweaks
      ?.highlight === true;
  return { kind: 'checked', event, highlighted };
}
