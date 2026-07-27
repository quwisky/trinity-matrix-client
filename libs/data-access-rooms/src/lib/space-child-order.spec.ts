import { describe, expect, it } from 'vitest';
import {
  compareOrder,
  isValidOrder,
  orderBetween,
  spreadOrders,
} from './space-child-order';

/** Sort ids by their keys the way the spec says a client must. */
function sorted(entries: { id: string; order: string }[]): string[] {
  return [...entries]
    .sort((a, b) => compareOrder(a.order, b.order))
    .map((entry) => entry.id);
}

describe('compareOrder', () => {
  it('orders by code point, not by locale collation', () => {
    // The whole reason this function exists: 'a'.localeCompare('B') is -1 under ICU, but
    // the spec sorts by code point, where 'B' (66) precedes 'a' (97). A client using
    // localeCompare disagrees with every other client about the same two keys.
    expect('a'.localeCompare('B')).toBe(-1);
    expect(compareOrder('a', 'B')).toBe(1);
  });

  it('sorts a shorter key before the longer key it prefixes', () => {
    expect(compareOrder('a', 'aa')).toBe(-1);
  });

  it('puts unordered children last, not first', () => {
    // '' precedes everything under plain `<`, which would float every child that has no
    // order to the TOP — the opposite of what the spec asks for.
    expect(compareOrder('', 'a')).toBe(1);
    expect(compareOrder('a', '')).toBe(-1);
    expect(compareOrder('', '')).toBe(0);
  });
});

describe('isValidOrder', () => {
  it('accepts the printable ASCII range the spec allows', () => {
    expect(isValidOrder('abcXYZ019')).toBe(true);
    expect(isValidOrder(' ')).toBe(true);
    expect(isValidOrder('~')).toBe(true);
    expect(isValidOrder('')).toBe(true);
  });

  it('rejects characters outside \\x20-\\x7E', () => {
    // An invalid key is not ignored — the spec says treat the child as unordered, so it
    // silently drops to the end of the list instead of erroring.
    expect(isValidOrder('café')).toBe(false);
    expect(isValidOrder('a\nb')).toBe(false);
    // Written as an escape: a literal DEL byte here renders as an empty string, which
    // reads as a contradiction of the `isValidOrder('')` case above.
    expect(isValidOrder('\x7F')).toBe(false);
  });

  it('rejects a key longer than 50 characters', () => {
    expect(isValidOrder('a'.repeat(50))).toBe(true);
    expect(isValidOrder('a'.repeat(51))).toBe(false);
  });
});

describe('orderBetween', () => {
  it('mints a key that sorts between two neighbours', () => {
    const key = orderBetween('a', 'c');

    expect(key).not.toBeNull();
    expect(compareOrder('a', key as string)).toBe(-1);
    expect(compareOrder(key as string, 'c')).toBe(-1);
  });

  it('goes deeper when the neighbours are adjacent digits', () => {
    // No single character sorts between 'a' and 'b', so the key has to grow a position.
    const key = orderBetween('a', 'b');

    expect(key).not.toBeNull();
    expect((key as string).length).toBeGreaterThan(1);
    expect(compareOrder('a', key as string)).toBe(-1);
    expect(compareOrder(key as string, 'b')).toBe(-1);
  });

  it('appends below an unbounded end', () => {
    const key = orderBetween('a', '');

    expect(compareOrder('a', key as string)).toBe(-1);
  });

  it('inserts above an unbounded start', () => {
    const key = orderBetween('', 'z');

    expect(compareOrder(key as string, 'z')).toBe(-1);
  });

  it('mints a key for a completely empty list', () => {
    const key = orderBetween('', '');

    expect(key).not.toBeNull();
    expect(isValidOrder(key as string)).toBe(true);
  });

  it('always produces a key the spec accepts', () => {
    const keys = [
      orderBetween('', ''),
      orderBetween('a', 'b'),
      orderBetween('', 'a'),
      orderBetween('zzzz', ''),
      orderBetween('0z', '10'),
    ];

    for (const key of keys) {
      expect(key).not.toBeNull();
      expect(isValidOrder(key as string)).toBe(true);
    }
  });

  it('reports no gap rather than inventing a key that sorts wrongly', () => {
    // Nothing can sort above '' and below the alphabet's first digit. Returning some
    // key anyway would put the child in the wrong place, which is worse than saying so
    // and letting the caller renumber.
    expect(orderBetween('', '0')).toBeNull();
  });

  it('reports no gap for a key it cannot do arithmetic on', () => {
    // '!' is legal in a key another client wrote but is outside our alphabet, so no
    // midpoint can be computed against it.
    expect(orderBetween('', '!')).toBeNull();
    expect(orderBetween('!', 'a')).toBeNull();
  });

  it('survives repeated insertion at the same point', () => {
    // The pathological case for any midpoint scheme: always inserting just after the
    // same key. Each round must still sort correctly and stay a legal length.
    let low = 'a';
    const high = 'b';
    for (let round = 0; round < 20; round++) {
      const key = orderBetween(low, high);
      expect(key).not.toBeNull();
      expect(isValidOrder(key as string)).toBe(true);
      expect(compareOrder(low, key as string)).toBe(-1);
      expect(compareOrder(key as string, high)).toBe(-1);
      low = key as string;
    }
  });

  it('moves a child between two others so the list reads in the new order', () => {
    // The end-to-end property the whole module exists for.
    const list = [
      { id: 'first', order: '1' },
      { id: 'second', order: '2' },
      { id: 'third', order: '3' },
    ];
    expect(sorted(list)).toEqual(['first', 'second', 'third']);

    const moved = orderBetween('1', '2') as string;
    const after = list.map((entry) =>
      entry.id === 'third' ? { ...entry, order: moved } : entry,
    );

    expect(sorted(after)).toEqual(['first', 'third', 'second']);
  });
});

describe('spreadOrders', () => {
  it('returns nothing for an empty list', () => {
    expect(spreadOrders(0)).toEqual([]);
    expect(spreadOrders(-1)).toEqual([]);
  });

  it('produces ascending, legal, distinct keys', () => {
    const keys = spreadOrders(10);

    expect(keys).toHaveLength(10);
    expect(new Set(keys).size).toBe(10);
    for (const key of keys) {
      expect(isValidOrder(key)).toBe(true);
    }
    for (let i = 1; i < keys.length; i++) {
      expect(compareOrder(keys[i - 1], keys[i])).toBe(-1);
    }
  });

  it('leaves room to insert above the first child', () => {
    // Renumbering that started at the very first digit would immediately reproduce the
    // no-gap case it was called to escape.
    const keys = spreadOrders(5);

    expect(orderBetween('', keys[0])).not.toBeNull();
  });

  it('leaves room to insert between neighbours', () => {
    const keys = spreadOrders(5);

    const inserted = orderBetween(keys[0], keys[1]);
    expect(inserted).not.toBeNull();
    expect(compareOrder(keys[0], inserted as string)).toBe(-1);
    expect(compareOrder(inserted as string, keys[1])).toBe(-1);
  });

  it('keeps ordering when there are more children than digits', () => {
    const keys = spreadOrders(200);

    expect(keys).toHaveLength(200);
    expect(new Set(keys).size).toBe(200);
    for (let i = 1; i < keys.length; i++) {
      expect(compareOrder(keys[i - 1], keys[i])).toBe(-1);
    }
    for (const key of keys) {
      expect(isValidOrder(key)).toBe(true);
    }
  });
});
