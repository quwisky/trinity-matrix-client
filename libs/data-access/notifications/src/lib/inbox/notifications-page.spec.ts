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
});
