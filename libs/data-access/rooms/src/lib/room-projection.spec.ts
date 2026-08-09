import { type MatrixClient, type Room } from 'matrix-js-sdk';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROOM_SORT,
  TRINITY_ROOM_SORTS,
  comparatorFor,
  compareRoomSummaries,
  isRoomSortMode,
  spaceChildIdsOf,
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
    markedUnread: false,
    lastMessage: '',
    activityTs: 0,
    favourite: false,
    lowPriority: false,
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

describe('spaceChildIdsOf', () => {
  interface ChildLink {
    id: string;
    name: string;
    order?: string;
  }

  /** A space whose live state holds one `m.space.child` per link, and its joined children. */
  function spaceOf(links: readonly ChildLink[]): {
    client: MatrixClient;
    space: Room;
  } {
    const space = {
      getLiveTimeline: () => ({
        getState: () => ({
          getStateEvents: (type: string) =>
            type === 'm.space.child'
              ? links.map((link) => ({
                  getStateKey: () => link.id,
                  getContent: () => ({
                    via: ['hs'],
                    ...(link.order === undefined ? {} : { order: link.order }),
                  }),
                }))
              : [],
        }),
      }),
    } as unknown as Room;
    const byId = new Map(links.map((link) => [link.id, link]));
    const client = {
      getRoom: (id: string) => {
        const link = byId.get(id);
        return link ? { name: link.name, getMyMembership: () => 'join' } : null;
      },
    } as unknown as MatrixClient;
    return { client, space };
  }

  it('orders order keys by code point, not by locale collation', () => {
    // MSC1772 mandates Unicode code point order, where 'B' (66) precedes 'a' (97).
    // `localeCompare` case-folds and puts 'a' first, which is the arrangement no other
    // Matrix client agrees with. Names run the other way so only the order field can
    // produce this result.
    const { client, space } = spaceOf([
      { id: '!upper:hs', name: 'zulu', order: 'B' },
      { id: '!lower:hs', name: 'alpha', order: 'a' },
    ]);
    expect(spaceChildIdsOf(client, space)).toEqual(['!upper:hs', '!lower:hs']);
  });

  it('sorts a child with no order key after the children that have one', () => {
    // The spec sorts children with a valid order ahead of those without, but
    // `''.localeCompare('z')` is -1, which floats the unordered child to the top.
    const { client, space } = spaceOf([
      { id: '!unordered:hs', name: 'alpha' },
      { id: '!ordered:hs', name: 'zulu', order: 'z' },
    ]);
    expect(spaceChildIdsOf(client, space)).toEqual([
      '!ordered:hs',
      '!unordered:hs',
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

  it('sinks low-priority rooms below everything in every mode', () => {
    // The mirror of the favourite test, and it has to hold in all three modes for the same
    // reason: the array order is what the keyboard walk and mark-all-read iterate, so a
    // mode that sank the room only visually would walk a different order from the rendered
    // one.
    // The demoted room has to be one that would otherwise sort FIRST in EVERY mode, or a
    // mode's leg proves nothing. The first version used an id outside CURATED, so in
    // 'space' mode it fell to UNRANKED and sorted last whether or not the rule existed —
    // deleting `lowPriorityLast` from that branch kept the whole suite green.
    // So: curated index 0, alphabetically first, and the most recent activity.
    const demoted = room({
      id: '!z:hs',
      name: 'aaa-first',
      activityTs: Number.MAX_SAFE_INTEGER,
      lowPriority: true,
    });
    for (const mode of TRINITY_ROOM_SORTS) {
      const order = sorted([demoted, ALPHA, MIKE], mode.id, CURATED);
      expect(order[0], `${mode.id}: would lead without the rule`).not.toBe(
        'aaa-first',
      );
      expect(order[order.length - 1], mode.id).toBe('aaa-first');
    }
  });

  it('keeps a room that is both favourite and low-priority with the favourites', () => {
    // Matrix allows both tags at once and says nothing about precedence. Favouriting is the
    // deliberate act, so it wins — pinned here because the alternative is equally arguable
    // and the two terms are applied in a fixed order to get this result.
    const both = room({
      id: '!q:hs',
      name: 'quebec',
      activityTs: 1,
      favourite: true,
      lowPriority: true,
    });
    for (const mode of TRINITY_ROOM_SORTS) {
      expect(sorted([...rooms, both], mode.id, CURATED)[0], mode.id).toBe(
        'quebec',
      );
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
