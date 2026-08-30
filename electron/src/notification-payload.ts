/**
 * Validation + coercion for the UNTRUSTED `show-notification` IPC payload.
 *
 * Side-effect-free and dependency-free (no `electron` import), so it can be unit
 * tested in plain node. `main.ts` calls {@link coerceNotificationPayload} before
 * constructing any OS `Notification`.
 */

export const NOTIFICATION_TITLE_LIMIT = 120;
export const NOTIFICATION_BODY_LIMIT = 300;
export const NOTIFICATION_ROOM_ID_LIMIT = 256;
export const NOTIFICATION_ACCOUNT_ID_LIMIT = 256;
export const NOTIFICATION_EVENT_ID_LIMIT = 256;

/** Validated, clamped notification request derived from an untrusted IPC payload. */
export interface NotificationRequest {
  title: string;
  body: string;
  destination: {
    accountId: string;
    roomId: string;
    eventId: string;
  };
  silent: boolean;
  /** Web-Notification-style collapse tag; forwarded by the preload bridge. */
  tag?: string;
}

/**
 * Clamp an untrusted IPC string: it must be a string; strip control characters
 * (defends against terminal/markup injection in the toast), trim, and cap length.
 */
function sanitizeNotificationText(value: unknown, limit: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * Validate + coerce the UNTRUSTED `show-notification` payload. Returns `null`
 * (so the caller shows nothing) for anything malformed: a non-object, a missing
 * room id, or an empty title+body. A string `tag` is passed through; any other
 * type is omitted.
 */
export function coerceNotificationPayload(
  raw: unknown,
): NotificationRequest | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const destination = rec['destination'];
  if (typeof destination !== 'object' || destination === null) return null;
  const target = destination as Record<string, unknown>;
  const accountId = sanitizeNotificationText(
    target['accountId'],
    NOTIFICATION_ACCOUNT_ID_LIMIT,
  );
  const roomId = sanitizeNotificationText(
    target['roomId'],
    NOTIFICATION_ROOM_ID_LIMIT,
  );
  const eventId = sanitizeNotificationText(
    target['eventId'],
    NOTIFICATION_EVENT_ID_LIMIT,
  );
  if (!accountId || !roomId || !eventId) return null;
  const title = sanitizeNotificationText(
    rec['title'],
    NOTIFICATION_TITLE_LIMIT,
  );
  const body = sanitizeNotificationText(rec['body'], NOTIFICATION_BODY_LIMIT);
  if (!title && !body) {
    return null; // empty notification => ignore
  }
  const request: NotificationRequest = {
    title,
    body,
    destination: { accountId, roomId, eventId },
    silent: rec['silent'] === true,
  };
  if (typeof rec['tag'] === 'string') {
    request.tag = rec['tag'];
  }
  return request;
}
