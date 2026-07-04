/**
 * Pure windowing math for the virtualized message timeline — no Angular, no DOM.
 *
 * The list keeps a `Map` of measured row heights (rendered rows only) and an
 * estimate for everything not yet seen. From a prefix-sum of those heights and the
 * scroll position it derives which rows to render plus the two spacer heights that
 * stand in for the off-screen rows, so the scroll container keeps its true height.
 *
 * Kept side-effect-free and DOM-free so it's fully unit-testable (jsdom has no
 * layout): the component feeds it plain numbers and applies the result.
 */

/** Measured heights (by row id) with a fallback estimate for unmeasured rows. */
export interface RowHeights {
  readonly measured: ReadonlyMap<string, number>;
  readonly estimate: number;
}

export interface WindowInput {
  /** Row ids in timeline order. */
  readonly ids: readonly string[];
  readonly heights: RowHeights;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  /** Extra pixels rendered above and below the viewport to hide boundary churn. */
  readonly overscanPx: number;
  /** Anchor to the newest row (render through the end, bottom spacer 0). */
  readonly pinBottom: boolean;
  /** At or below this row count, render everything (no windowing). */
  readonly smallListThreshold: number;
  /** Master switch — when false, always render everything (feature flag off). */
  readonly enabled: boolean;
}

export interface WindowResult {
  /** First rendered row (inclusive). */
  readonly startIndex: number;
  /** Last rendered row (inclusive); -1 when there are no rows. */
  readonly endIndex: number;
  /** Height of the top spacer standing in for rows before {@link startIndex}. */
  readonly topPadPx: number;
  /** Height of the bottom spacer standing in for rows after {@link endIndex}. */
  readonly bottomPadPx: number;
  /** Total height of all rows (measured + estimated). */
  readonly totalHeightPx: number;
}

/** Measured height for a row, or the estimate when it hasn't been rendered yet. */
export function rowHeight(id: string, h: RowHeights): number {
  return h.measured.get(id) ?? h.estimate;
}

/**
 * Prefix sums of row heights: `prefix[i]` is the offset of the top of row `i`,
 * `prefix[N]` is the total height. Length N+1, `prefix[0] === 0`.
 */
export function buildPrefixSums(
  ids: readonly string[],
  h: RowHeights,
): Float64Array {
  const prefix = new Float64Array(ids.length + 1);
  for (let i = 0; i < ids.length; i++) {
    prefix[i + 1] = prefix[i] + rowHeight(ids[i], h);
  }
  return prefix;
}

/** Top offset of row `index` (clamped to a valid prefix index). */
export function offsetOf(prefix: Float64Array, index: number): number {
  const clamped = Math.max(0, Math.min(index, prefix.length - 1));
  return prefix[clamped];
}

/** A rendered row that just changed height, with its PRE-change height. */
export interface HeightChange {
  readonly index: number;
  /** Height before the change (the estimate for a first measurement). */
  readonly prior: number;
  readonly next: number;
}

/**
 * How much to shift `scrollTop` to keep the read position stable after some rendered
 * rows changed height, when the user is scrolled up (not pinned to the bottom). A row
 * fully ABOVE the fold that grows or shrinks shoves everything below it — including
 * the viewport — by its delta, so those deltas are summed.
 *
 * `prefix` are the PRE-change offsets. `regionTop` is the content offset of the row
 * region from the scroll origin — the `.scroll` padding plus any load-older banner
 * rendered above the rows — so the above-the-fold test is done in the same coordinate
 * system as the physical `scrollTop`. Returns 0 when nothing above the fold changed.
 */
export function scrollCompensation(
  changes: readonly HeightChange[],
  prefix: Float64Array,
  scrollTop: number,
  regionTop: number,
): number {
  let delta = 0;
  for (const c of changes) {
    // Physical bottom edge of the row before the change.
    if (regionTop + offsetOf(prefix, c.index) + c.prior <= scrollTop) {
      delta += c.next - c.prior;
    }
  }
  return delta;
}

/**
 * Index of the row that contains vertical offset `y` — the largest `i` in
 * `[0, N-1]` with `prefix[i] <= y`. A row spans `[prefix[i], prefix[i+1])`, so an
 * offset exactly on a boundary belongs to the following row. Clamped to
 * `[0, N-1]`; returns 0 for an empty list.
 */
export function indexAtOffset(prefix: Float64Array, y: number): number {
  const n = prefix.length - 1;
  if (n <= 0 || y <= 0) {
    return 0;
  }
  if (y >= prefix[n]) {
    return n - 1;
  }
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix[mid] <= y) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/**
 * Resolve the render window and spacer heights. `prefix` must be
 * {@link buildPrefixSums} for the same ids/heights (passed in so the caller can
 * memoize and reuse it across window/offset queries).
 */
export function computeWindow(
  input: WindowInput,
  prefix: Float64Array,
): WindowResult {
  const {
    ids,
    scrollTop,
    viewportHeight,
    overscanPx,
    pinBottom,
    smallListThreshold,
    enabled,
  } = input;
  const n = ids.length;
  const total = prefix[n];

  if (n === 0) {
    return {
      startIndex: 0,
      endIndex: -1,
      topPadPx: 0,
      bottomPadPx: 0,
      totalHeightPx: 0,
    };
  }

  // Fast path: virtualization off, or a list short enough that windowing isn't
  // worth it — render everything, identical to the un-virtualized list.
  if (!enabled || n <= smallListThreshold) {
    return {
      startIndex: 0,
      endIndex: n - 1,
      topPadPx: 0,
      bottomPadPx: 0,
      totalHeightPx: total,
    };
  }

  if (pinBottom) {
    // Anchor to the newest row and grow the window upward until it covers the
    // viewport plus overscan. Keeps the bottom spacer at 0 so `scrollTop =
    // scrollHeight` lands on real content (no blank space) for live/own messages.
    const endIndex = n - 1;
    let startIndex = n - 1;
    const target = viewportHeight + overscanPx;
    while (startIndex > 0 && total - prefix[startIndex] < target) {
      startIndex--;
    }
    return {
      startIndex,
      endIndex,
      topPadPx: prefix[startIndex],
      bottomPadPx: 0,
      totalHeightPx: total,
    };
  }

  const startIndex = indexAtOffset(prefix, scrollTop - overscanPx);
  const endIndex = indexAtOffset(
    prefix,
    scrollTop + viewportHeight + overscanPx,
  );
  return {
    startIndex,
    endIndex,
    topPadPx: prefix[startIndex],
    bottomPadPx: total - prefix[endIndex + 1],
    totalHeightPx: total,
  };
}
