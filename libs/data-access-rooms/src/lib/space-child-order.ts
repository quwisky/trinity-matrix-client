/**
 * `m.space.child` **order** keys — the string a space admin sets so everyone sees the
 * children in the intended arrangement.
 *
 * The spec constrains the field tightly: at most 50 characters, every character in
 * `\x20`–`\x7E`, and children sorted by **Unicode code point** order. Two consequences
 * shape everything here.
 *
 * First, code point order is NOT `localeCompare` order: ICU collation puts `'a'` before
 * `'B'`, while code points put `'B'` (66) before `'a'` (97). Keys generated for one and
 * compared with the other disagree, so {@link compareOrder} exists and every comparison
 * goes through it.
 *
 * Second, reordering must not rewrite the whole sibling list. Each child link is its own
 * state event, so renumbering ten siblings to move one is ten events in the space's
 * timeline. Instead {@link orderBetween} mints a key that sorts strictly between its new
 * neighbours, so one move is one write.
 */

/**
 * The digits generated keys are built from — a code-point-ordered subset of the legal
 * range (`0`–`9`, `A`–`Z`, `a`–`z`). Deliberately narrower than the spec allows: it
 * excludes the space character, which is legal but invisible and so a poor thing to put
 * in a value humans may inspect, and it is contiguous in code point order, which is what
 * makes midpoint arithmetic below sound.
 */
const ORDER_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** The spec's hard limit on an order key. */
const MAX_ORDER_LENGTH = 50;

/** Legal order characters per the spec — `\x20`–`\x7E` inclusive. */
const LEGAL_ORDER = /^[\x20-\x7E]*$/;

/**
 * Whether `order` is a value the spec allows in `m.space.child`.
 *
 * An out-of-range key is not merely ugly: the spec says a child whose `order` is invalid
 * must be treated as having **no** order at all, so a rejected key silently moves the
 * child to the end rather than failing loudly.
 */
export function isValidOrder(order: string): boolean {
  return order.length <= MAX_ORDER_LENGTH && LEGAL_ORDER.test(order);
}

/**
 * Compare two order keys by Unicode code point, which is what the spec mandates and what
 * `localeCompare` does not do.
 *
 * An empty key means "unordered". The spec sorts children with a valid order ahead of
 * those without, so an empty key sorts last rather than first — which plain `<` would get
 * backwards, since `''` precedes everything.
 */
export function compareOrder(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (!a) {
    return 1;
  }
  if (!b) {
    return -1;
  }
  return a < b ? -1 : 1;
}

/**
 * Mint a key that sorts strictly after `prev` and strictly before `next`, or `null` when
 * no key can exist between them.
 *
 * Pass `''` for either side to mean unbounded: `orderBetween('', first)` inserts at the
 * top, `orderBetween(last, '')` at the bottom.
 *
 * `null` is a real outcome, not a failure to handle later. Keys are finite strings, so a
 * caller can always construct a pair with no gap — most obviously by asking to insert
 * before a child whose key is already the lowest digit. The caller's answer is to
 * renumber the siblings with {@link spreadOrders}; returning `null` says which of the two
 * paths to take rather than inventing a key that sorts in the wrong place.
 */
export function orderBetween(prev: string, next: string): string | null {
  let result = '';
  let bounded = next.length > 0;
  for (let index = 0; result.length < MAX_ORDER_LENGTH; index++) {
    const low = index < prev.length ? ORDER_ALPHABET.indexOf(prev[index]) : -1;
    const high = bounded
      ? index < next.length
        ? ORDER_ALPHABET.indexOf(next[index])
        : 0
      : ORDER_ALPHABET.length;
    // A character outside our alphabet is legal in a key another client wrote, but we
    // cannot do midpoint arithmetic across it — renumber instead of guessing.
    if (low === -1 && index < prev.length) {
      return null;
    }
    if (high === -1) {
      return null;
    }
    if (high - low >= 2) {
      return result + ORDER_ALPHABET[low + Math.floor((high - low) / 2)];
    }
    // The digits are adjacent (or equal), so no key fits at this position: take `prev`'s
    // digit and look for room one position deeper.
    if (low < 0) {
      // Nothing sorts below the alphabet's first digit at this position.
      return null;
    }
    result += ORDER_ALPHABET[low];
    // Having taken a digit strictly below `next`'s, every suffix now sorts before `next`,
    // so the upper bound stops applying.
    if (high === low + 1) {
      bounded = false;
    }
  }
  return null;
}

/**
 * Evenly spaced keys for `count` children — the renumbering fallback for when
 * {@link orderBetween} reports no gap, and the way an unordered list is given orders for
 * the first time.
 *
 * Spread across the alphabet rather than packed (`0`, `1`, `2`, …) so later single-key
 * inserts have somewhere to land: consecutive keys are exactly the case that forces
 * another renumber.
 */
export function spreadOrders(count: number): string[] {
  if (count <= 0) {
    return [];
  }
  const width = Math.max(1, Math.ceil(count / (ORDER_ALPHABET.length - 2)));
  const step = Math.max(
    1,
    Math.floor((ORDER_ALPHABET.length - 2) / Math.max(1, count)),
  );
  return Array.from({ length: count }, (_unused, index) => {
    if (width === 1) {
      // Start at the second digit so there is always room to insert above the first.
      return ORDER_ALPHABET[1 + index * step];
    }
    // More children than digits: fall back to fixed-width base-N counting.
    let remaining = index + 1;
    let key = '';
    for (let position = 0; position < width; position++) {
      key = ORDER_ALPHABET[remaining % ORDER_ALPHABET.length] + key;
      remaining = Math.floor(remaining / ORDER_ALPHABET.length);
    }
    return key;
  });
}
