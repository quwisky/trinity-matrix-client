import { RING_EVENT_TYPES, ringVideo } from '@trinity/util/matrix';

export interface RingEvent {
  eventId: string;
  roomId: string;
  sender: string;
  type: string;
  content: unknown;
  originServerTs: number;
}

export interface IncomingRing {
  /** The ring event id. */
  id: string;
  roomId: string;
  accountId: string;
  callerId: string;
  callerName: string;
  video: boolean | null;
  expiresAt: number;
}

export { RING_EVENT_TYPES, ringVideo };
export const DECLINE_EVENT_TYPE = 'org.matrix.msc4310.rtc.decline';

const MAX_LIFETIME_MS = 120_000;
const DEFAULT_LIFETIME_MS = 90_000;

function fieldsOf(content: unknown): Record<string, unknown> | null {
  return typeof content === 'object' && content !== null
    ? (content as Record<string, unknown>)
    : null;
}

/** Epoch ms when the ring stops being valid, or null when it is not a live ring. */
export function ringExpiry(event: RingEvent, nowMs: number): number | null {
  const fields = fieldsOf(event.content);
  if (!RING_EVENT_TYPES.includes(event.type) || !fields) return null;
  if (fields['notification_type'] !== 'ring') return null;
  const sentAt = fields['sender_ts'];
  const lifetime = fields['lifetime'] ?? DEFAULT_LIFETIME_MS;
  if (typeof sentAt !== 'number' || typeof lifetime !== 'number') return null;
  const base = sentAt <= nowMs ? sentAt : event.originServerTs;
  const expiresAt = base + Math.min(lifetime, MAX_LIFETIME_MS);
  return expiresAt > nowMs ? expiresAt : null;
}
