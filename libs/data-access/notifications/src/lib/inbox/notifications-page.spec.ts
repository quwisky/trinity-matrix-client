import { describe, expect, it } from 'vitest';
import { parseNotificationsPage } from './notifications-page';

const good = (id: string, extra: Record<string, unknown> = {}) => ({
  room_id: '!r:hs',
  read: false,
  ts: 5,
  event: { event_id: id, type: 'm.room.message' },
  ...extra,
});

describe('parseNotificationsPage', () => {
  it('skips malformed entries and keeps the rest', () => {
    const page = parseNotificationsPage({
      notifications: [
        good('$a'),
        { room_id: '!r:hs', ts: 1 },
        good('$b', { room_id: 4 }),
        good('nope'),
        good('$q"x'),
        good('$ok', { ts: Infinity }),
        good('$ok2', { ts: 'x' }),
        'junk',
        good('$c', { read: true }),
      ],
    });
    expect(page.entries.map((e) => [e.eventId, e.read])).toEqual([
      ['$a', false],
      ['$c', true],
    ]);
    expect(page.entries[0]).toMatchObject({ roomId: '!r:hs', ts: 5 });
  });

  it('throws on a body that is not an answer', () => {
    for (const body of [null, 'x', [], {}, { notifications: 'x' }]) {
      expect(() => parseNotificationsPage(body)).toThrow();
    }
  });

  it('reads a missing next_token as the end', () => {
    expect(parseNotificationsPage({ notifications: [] }).nextToken).toBeNull();
    expect(
      parseNotificationsPage({ notifications: [], next_token: 7 }).nextToken,
    ).toBeNull();
    expect(
      parseNotificationsPage({ notifications: [], next_token: 't' }).nextToken,
    ).toBe('t');
  });

  it('prefers the event time over the receive time', () => {
    const page = parseNotificationsPage({
      notifications: [
        good('$a', { ts: 9, event: { event_id: '$a', origin_server_ts: 3 } }),
        good('$b', { ts: 9, event: { event_id: '$b', origin_server_ts: 'x' } }),
      ],
    });
    expect(page.entries.map((e) => e.ts)).toEqual([3, 9]);
  });

  it('caps a page at 500 entries', () => {
    const notifications = Array.from({ length: 600 }, (_, i) => good(`$e${i}`));
    expect(parseNotificationsPage({ notifications }).entries).toHaveLength(500);
  });

  it('skips an unsafe sender', () => {
    const page = parseNotificationsPage({
      notifications: [
        good('$a', { event: { event_id: '$a', sender: '__proto__' } }),
      ],
    });
    expect(page.entries).toEqual([]);
  });
});
