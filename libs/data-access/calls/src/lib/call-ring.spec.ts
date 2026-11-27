import { describe, expect, it } from 'vitest';
import { ringExpiry, ringVideo, type RingEvent } from './call-ring';

const NOW = 1_000_000_000;
const ring = (content: unknown, over: Partial<RingEvent> = {}): RingEvent => ({
  eventId: '$r',
  roomId: '!d:hs',
  sender: '@bob:hs',
  type: 'org.matrix.msc4075.rtc.notification',
  content,
  originServerTs: NOW,
  ...over,
});
const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  notification_type: 'ring',
  sender_ts: NOW - 1000,
  lifetime: 30_000,
  ...over,
});

describe('ringExpiry', () => {
  it('is sender_ts plus lifetime', () => {
    expect(ringExpiry(ring(body()), NOW)).toBe(NOW - 1000 + 30_000);
  });
  it('caps the lifetime at 120 s', () => {
    expect(ringExpiry(ring(body({ lifetime: 600_000 })), NOW)).toBe(
      NOW - 1000 + 120_000,
    );
  });
  it('rejects a plain notification', () => {
    expect(
      ringExpiry(ring(body({ notification_type: 'notification' })), NOW),
    ).toBeNull();
  });
  it('rejects an expired ring', () => {
    expect(ringExpiry(ring(body({ sender_ts: NOW - 31_000 })), NOW)).toBeNull();
  });
  it('uses the server timestamp when sender_ts is in the future', () => {
    expect(
      ringExpiry(
        ring(body({ sender_ts: NOW + 600_000 }), {
          originServerTs: NOW - 5000,
        }),
        NOW,
      ),
    ).toBe(NOW - 5000 + 30_000);
  });
  it('accepts m.rtc.notification', () => {
    expect(
      ringExpiry(ring(body(), { type: 'm.rtc.notification' }), NOW),
    ).not.toBeNull();
  });
  it('rejects other types and garbage content', () => {
    expect(
      ringExpiry(ring(body(), { type: 'm.room.message' }), NOW),
    ).toBeNull();
    expect(ringExpiry(ring('x'), NOW)).toBeNull();
    expect(ringExpiry(ring(null), NOW)).toBeNull();
    expect(ringExpiry(ring(body({ sender_ts: '1' })), NOW)).toBeNull();
    expect(ringExpiry(ring(body({ lifetime: 'long' })), NOW)).toBeNull();
  });
});

describe('ringVideo', () => {
  it('maps the intent', () => {
    expect(ringVideo({ 'm.call.intent': 'video' })).toBe(true);
    expect(ringVideo({ 'm.call.intent': 'audio' })).toBe(false);
    expect(ringVideo({})).toBeNull();
    expect(ringVideo(undefined)).toBeNull();
  });
});
