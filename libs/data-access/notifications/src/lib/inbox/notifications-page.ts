export interface NotificationEntry {
  readonly roomId: string;
  readonly read: boolean;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly eventId: string;
  readonly ts: number;
}

export interface NotificationsPage {
  readonly entries: readonly NotificationEntry[];
  readonly nextToken: string | null;
}

/** A server answering far above the asked limit must not balloon decryption. */
const MAX_ENTRIES_PER_PAGE = 500;

const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Event IDs reach a CSS selector later, so only a plain `$id` passes. */
export function isPlainEventId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith('$') && !/["'\\\s\]]/.test(id);
}

function parseEntry(item: unknown): NotificationEntry | null {
  if (!isRecord(item)) return null;
  const { event, room_id: roomId, read, ts } = item;
  if (!isRecord(event) || typeof roomId !== 'string' || roomId === '') {
    return null;
  }
  const eventId = event['event_id'];
  if (
    !isPlainEventId(eventId) ||
    UNSAFE_NAMES.has(roomId) ||
    UNSAFE_NAMES.has(String(event['sender']))
  ) {
    return null;
  }
  // The entry's `ts` is the server's receive time; the index records the event's own time.
  const originTs = event['origin_server_ts'];
  const eventTs = Number.isFinite(originTs) ? originTs : ts;
  if (typeof eventTs !== 'number' || !Number.isFinite(eventTs)) return null;
  return { roomId, read: read === true, raw: event, eventId, ts: eventTs };
}

/** Parses a `/notifications` body strictly: bad entries are skipped, a bad body throws. */
export function parseNotificationsPage(body: unknown): NotificationsPage {
  if (!isRecord(body) || !Array.isArray(body['notifications'])) {
    throw new TypeError('notifications: not an answer');
  }
  const entries: NotificationEntry[] = [];
  const items = (body['notifications'] as unknown[]).slice(
    0,
    MAX_ENTRIES_PER_PAGE,
  );
  for (const item of items) {
    const entry = parseEntry(item);
    if (entry) entries.push(entry);
  }
  const next = body['next_token'];
  return {
    entries,
    nextToken: typeof next === 'string' && next !== '' ? next : null,
  };
}
