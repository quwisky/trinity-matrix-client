import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROOM_SORT,
  TRINITY_ROOM_SORTS,
  comparatorFor,
  compareRoomSummaries,
  isRoomSortMode,
  spaceRankOf,
} from './room-projection';
import { type RoomSummary } from './rooms.service';

function room(over: Partial<RoomSummary> & { id: string }): RoomSummary {
  return {
    accountId: '@me:hs',
    accountIds: ['@me:hs'],
    name: over.id,
    initial: 'X',
    avatarMxc: null,
    topic: '',
    memberCount: 0,
    encrypted: false,
    unreadCount: 0,
    highlightCount: 0,
    hasUnread: false,
    lastMessage: '',
    activityTs: 0,
    favourite: false,
    ...over,
  };
}

/**
 * The three orderings must disagree pairwise, or an assertion could pass under the wrong mode.
 * Curated order is z, a, m; alphabetical is a, m, z; recency is m, z, a.
 */
const ZULU = room({ id: '!z:hs', name: 'zulu', activityTs: 200 });
const ALPHA = room({ id: '!a:hs', name: 'alpha', activityTs: 100 });
const MIKE = room({ id: '!m:hs', name: 'mike', activityTs: 300 });
const CURATED = ['!z:hs', '!a:hs', '!m:hs'];

/** Sorts a copy, so the shared fixture array is never reordered between tests. */
function sorted(
  rooms: readonly RoomSummary[],
  ...args: Parameters<typeof comparatorFor>
): string[] {
  return [...rooms].sort(comparatorFor(...args)).map((entry) => entry.name);
}

describe('room sort modes', () => {
  it('defaults to recent activity', () => {
    expect(DEFAULT_ROOM_SORT).toBe('recent');
  });

  it('gives every ordering a label and a description', () => {
    // Both surfaces let you choose an ordering without seeing its effect, and "Space order"
    // says nothing about whose order it is — so a missing description is a real gap.
    for (const option of TRINITY_ROOM_SORTS) {
      expect(option.label.length, option.id).toBeGreaterThan(0);
      expect(option.description.length, option.id).toBeGreaterThan(0);
    }
  });

  it('accepts the ids it ships and rejects everything else', () => {
    for (const option of TRINITY_ROOM_SORTS) {
      expect(isRoomSortMode(option.id)).toBe(true);
    }
    for (const value of ['a-z', 'activity', '', null, undefined]) {
      expect(isRoomSortMode(value)).toBe(false);
    }
  });
});

describe('spaceRankOf', () => {
  it('ranks ids by their position in the curated order', () => {
    expect([...spaceRankOf(CURATED)]).toEqual([
      ['!z:hs', 0],
      ['!a:hs', 1],
      ['!m:hs', 2],
    ]);
  });

  it('keeps the first occurrence of a repeated id', () => {
    // Neither producer repeats a child today — `spaceChildIdsOf` reads one state event per
    // child and `MixedSpacesService` dedupes as it concatenates — so this pins the contract
    // of an exported pure function rather than a scenario the app reaches.
    expect([...spaceRankOf(['!a:hs', '!b:hs', '!a:hs'])]).toEqual([
      ['!a:hs', 0],
      ['!b:hs', 1],
    ]);
  });
});

describe('comparatorFor', () => {
  const rooms = [ZULU, ALPHA, MIKE];

  it('orders by recency, ignoring both name and curated order', () => {
    expect(sorted(rooms, 'recent')).toEqual(['mike', 'zulu', 'alpha']);
  });

  it('orders by name, ignoring both recency and curated order', () => {
    expect(sorted(rooms, 'alphabetical', CURATED)).toEqual([
      'alpha',
      'mike',
      'zulu',
    ]);
  });

  it('preserves the curated order, ignoring name and recency', () => {
    expect(sorted(rooms, 'space', CURATED)).toEqual(['zulu', 'alpha', 'mike']);
  });

  it('reuses the app-wide comparator for recency, by identity', () => {
    // So "recent inside a space" cannot drift from the order every other list uses.
    expect(comparatorFor('recent')).toBe(compareRoomSummaries);
  });

  it('floats favourites above everything in every mode', () => {
    const starred = room({
      id: '!q:hs',
      name: 'quebec',
      activityTs: 1,
      favourite: true,
    });
    for (const mode of TRINITY_ROOM_SORTS) {
      expect(sorted([...rooms, starred], mode.id, CURATED)[0]).toBe('quebec');
    }
  });

  describe('space mode with an unranked room', () => {
    const stray = room({ id: '!x:hs', name: 'xray', activityTs: 999 });

    it('sorts a room the curated order does not hold last', () => {
      expect(sorted([stray, ...rooms], 'space', CURATED)).toEqual([
        'zulu',
        'alpha',
        'mike',
        'xray',
      ]);
    });

    it('is a total order over two unranked rooms', () => {
      // `undefined - undefined` would be NaN, which makes `sort`'s result
      // implementation-defined and the list order irreproducible between runs.
      const other = room({ id: '!y:hs', name: 'yankee' });
      const compare = comparatorFor('space', CURATED);
      expect(Number.isNaN(compare(stray, other))).toBe(false);
      expect(sorted([other, stray], 'space', CURATED)).toEqual([
        'xray',
        'yankee',
      ]);
    });
  });
});
