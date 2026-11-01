import {
  Method,
  ReceiptType,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { firstValueFrom, from, timeout } from 'rxjs';
import { STEP_LIMIT_MS } from './mention-index.service';
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

/** Past the limit a wedged crypto call rejects, and its late answer is ignored. */
export function withinStepLimit<T>(work: Promise<T>): Promise<T> {
  return firstValueFrom(from(work).pipe(timeout(STEP_LIMIT_MS)));
}

/** A copy left on a thread stays in the thread's listeners, and its text with it. */
function releaseFromThread(copy: MatrixEvent): void {
  const rootId = copy.threadRootId;
  copy.setThread(undefined);
  copy.setThreadId(rootId);
}

export function mapInboxEvent(
  client: MatrixClient,
  raw: Readonly<Record<string, unknown>>,
  roomId: string,
): MatrixEvent {
  const room = client.getRoom(roomId);
  // Given an event the room holds, the mapper merges the server's `unsigned` into the room's own.
  const known = room?.findEventById(String(raw['event_id']));
  if (known) return known;
  const event = client.getEventMapper({ preventReEmit: true, decrypt: false })({
    ...raw,
    room_id: roomId,
  } as Parameters<ReturnType<MatrixClient['getEventMapper']>>[0]);
  for (const copy of [event, event.replacingEvent()]) {
    if (copy && room?.findEventById(copy.getId() ?? '') !== copy) {
      releaseFromThread(copy);
    }
  }
  return event;
}

/** Whether this device knows the person has read this event. */
export function hasReadOnDevice(
  room: Room | null,
  userId: string,
  eventId: string,
  ts: number,
): boolean {
  if (!room) return false;
  if (room.findEventById(eventId))
    return room.hasUserReadEvent(userId, eventId);
  // shortcut: compares times, so an old unread thread mention or a late federated one loses its dot; upgrade if the SDK can place an unloaded event.
  const readAt = Math.max(
    ...[ReceiptType.Read, ReceiptType.ReadPrivate].map(
      (type) => room.getReadReceiptForUserId(userId, false, type)?.data.ts ?? 0,
    ),
  );
  return ts <= readAt;
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
    // A status alone may be a proxy's or a server limit's, and this deletes the record.
    const errcode = (error as { errcode?: unknown } | null)?.errcode;
    return errcode === 'M_FORBIDDEN' || errcode === 'M_NOT_FOUND'
      ? { kind: 'gone' }
      : { kind: 'unreachable' };
  }
}

export type InboxEventCheck =
  | { readonly kind: 'dropped' }
  | {
      readonly kind: 'undecryptable';
      readonly event: MatrixEvent;
      /** The message reads, but its latest edit doesn't: its text is what the sender replaced. */
      readonly editOnly: boolean;
    }
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

async function decrypts(
  client: MatrixClient,
  event: MatrixEvent,
): Promise<boolean> {
  if (!event.isEncrypted()) return true;
  if (event.getClearContent() === null && !client.getCrypto()) return false;
  try {
    await withinStepLimit(client.decryptEventIfNeeded(event));
  } catch {
    return false;
  }
  return !event.isDecryptionFailure() && event.getClearContent() !== null;
}

export async function checkInboxEvent(
  client: MatrixClient,
  event: MatrixEvent,
): Promise<InboxEventCheck> {
  if (event.isRedacted()) return { kind: 'dropped' };
  if (!(await decrypts(client, event))) {
    return { kind: 'undecryptable', event, editOnly: false };
  }
  if (event.isRedacted()) return { kind: 'dropped' };
  const edit = event.replacingEvent();
  if (edit && !(await decrypts(client, edit))) {
    return { kind: 'undecryptable', event, editOnly: true };
  }
  // A legacy edit highlights by display name again, so it never counts. Own messages never do.
  const highlighted =
    event.getRelation()?.rel_type !== RelationType.Replace &&
    event.getSender() !== client.getUserId() &&
    client.getPushActionsForEvent(event, !isRoomsOwn(client, event))?.tweaks
      ?.highlight === true;
  return { kind: 'checked', event, highlighted };
}
