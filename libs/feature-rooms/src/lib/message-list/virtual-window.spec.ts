import { describe, expect, it } from 'vitest';
import {
  buildPrefixSums,
  computeWindow,
  indexAtOffset,
  offsetOf,
  rowHeight,
  scrollCompensation,
  type RowHeights,
  type WindowInput,
} from './virtual-window';

function heights(measured: Record<string, number>, estimate = 10): RowHeights {
  return { measured: new Map(Object.entries(measured)), estimate };
}

/** N ids: `$0`, `$1`, … */
function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `$${i}`);
}

describe('virtual-window', () => {
  describe('rowHeight', () => {
    it('returns the measured height when present', () => {
      expect(rowHeight('$0', heights({ $0: 42 }))).toBe(42);
    });
    it('falls back to the estimate when unmeasured', () => {
      expect(rowHeight('$1', heights({ $0: 42 }, 64))).toBe(64);
    });
  });

  describe('buildPrefixSums', () => {
    it('starts at 0 and ends at the total', () => {
      const p = buildPrefixSums(ids(3), heights({}, 10));
      expect(Array.from(p)).toEqual([0, 10, 20, 30]);
    });
    it('mixes measured and estimated heights', () => {
      const p = buildPrefixSums(ids(3), heights({ $1: 100 }, 10));
      expect(Array.from(p)).toEqual([0, 10, 110, 120]);
    });
    it('is empty-safe (just the zero sentinel)', () => {
      expect(Array.from(buildPrefixSums([], heights({})))).toEqual([0]);
    });
  });

  describe('offsetOf', () => {
    const p = buildPrefixSums(ids(3), heights({}, 10));
    it('returns the top offset of a row', () => {
      expect(offsetOf(p, 0)).toBe(0);
      expect(offsetOf(p, 2)).toBe(20);
    });
    it('clamps out-of-range indices', () => {
      expect(offsetOf(p, -5)).toBe(0);
      expect(offsetOf(p, 99)).toBe(30); // prefix[N]
    });
  });

  describe('indexAtOffset', () => {
    const p = buildPrefixSums(ids(5), heights({}, 10)); // rows [0,10)…[40,50)
    it('maps an offset to its containing row', () => {
      expect(indexAtOffset(p, 0)).toBe(0);
      expect(indexAtOffset(p, 5)).toBe(0);
      expect(indexAtOffset(p, 10)).toBe(1); // a boundary belongs to the next row
      expect(indexAtOffset(p, 25)).toBe(2);
      expect(indexAtOffset(p, 49)).toBe(4);
    });
    it('clamps below 0 and above the total', () => {
      expect(indexAtOffset(p, -100)).toBe(0);
      expect(indexAtOffset(p, 10_000)).toBe(4); // N-1
    });
    it('is empty-safe', () => {
      expect(indexAtOffset(buildPrefixSums([], heights({})), 5)).toBe(0);
    });
  });

  describe('computeWindow', () => {
    // 100 rows × 10px = 1000px total.
    const base = (over: Partial<WindowInput>): WindowInput => ({
      ids: ids(100),
      heights: heights({}, 10),
      scrollTop: 0,
      viewportHeight: 100,
      overscanPx: 0,
      pinBottom: false,
      smallListThreshold: 20,
      enabled: true,
      ...over,
    });

    function run(over: Partial<WindowInput>) {
      const input = base(over);
      return computeWindow(input, buildPrefixSums(input.ids, input.heights));
    }

    it('returns an empty result for no rows', () => {
      expect(run({ ids: [] })).toEqual({
        startIndex: 0,
        endIndex: -1,
        topPadPx: 0,
        bottomPadPx: 0,
        totalHeightPx: 0,
      });
    });

    it('renders every row when disabled (feature flag off)', () => {
      const r = run({ enabled: false });
      expect(r.startIndex).toBe(0);
      expect(r.endIndex).toBe(99);
      expect(r.topPadPx).toBe(0);
      expect(r.bottomPadPx).toBe(0);
    });

    it('renders every row for a short list (<= threshold)', () => {
      const r = run({ ids: ids(20), smallListThreshold: 20 });
      expect(r.endIndex).toBe(19);
      expect(r.topPadPx).toBe(0);
      expect(r.bottomPadPx).toBe(0);
    });

    it('windows to the visible range plus overscan', () => {
      // scrollTop 300, viewport 100, overscan 50 → covers [250, 450].
      const r = run({ scrollTop: 300, viewportHeight: 100, overscanPx: 50 });
      expect(r.startIndex).toBe(25); // top of row 25 is 250
      expect(r.endIndex).toBe(45); // row 45 spans [450,460), contains 450
      expect(r.topPadPx).toBe(250);
      expect(r.bottomPadPx).toBe(1000 - 460);
    });

    it('pins the window to the newest row', () => {
      const r = run({ pinBottom: true, viewportHeight: 100 });
      expect(r.endIndex).toBe(99);
      expect(r.bottomPadPx).toBe(0);
      expect(r.startIndex).toBe(90); // 10 rows × 10px == viewport
      expect(r.topPadPx).toBe(900);
    });

    it('grows the pinned window to cover viewport + overscan', () => {
      const r = run({ pinBottom: true, viewportHeight: 100, overscanPx: 200 });
      expect(r.endIndex).toBe(99);
      expect(r.startIndex).toBe(70); // 300px / 10px
      expect(r.bottomPadPx).toBe(0);
    });

    it('always keeps topPad + visible + bottomPad === total', () => {
      for (const over of [
        { scrollTop: 0 },
        { scrollTop: 500, viewportHeight: 120, overscanPx: 30 },
        { scrollTop: 990, viewportHeight: 100 },
        { pinBottom: true, viewportHeight: 137, overscanPx: 40 },
      ]) {
        const r = run(over);
        const visible = (r.endIndex - r.startIndex + 1) * 10;
        expect(r.topPadPx + visible + r.bottomPadPx).toBe(r.totalHeightPx);
        expect(r.totalHeightPx).toBe(1000);
      }
    });

    it('handles a scrollTop past the end without overrunning', () => {
      const r = run({ scrollTop: 100_000, viewportHeight: 100 });
      expect(r.endIndex).toBe(99);
      expect(r.bottomPadPx).toBe(0);
    });
  });

  describe('scrollCompensation', () => {
    // 100 rows × 10px each; prefix offsets 0, 10, …, 1000.
    const prefix = buildPrefixSums(ids(100), heights({}, 10));

    it('is 0 when nothing above the fold changed', () => {
      // Row 50 (offset 500) is below scrollTop 100 — not above the fold.
      expect(
        scrollCompensation(
          [{ index: 50, prior: 10, next: 30 }],
          prefix,
          100,
          0,
        ),
      ).toBe(0);
    });

    it('compensates by the delta for a row fully above the fold', () => {
      // Row 2 (offset 20, bottom 30 ≤ 100) grows by 40.
      expect(
        scrollCompensation([{ index: 2, prior: 10, next: 50 }], prefix, 100, 0),
      ).toBe(40);
    });

    it('sums deltas across above-fold rows and ignores in-view ones', () => {
      expect(
        scrollCompensation(
          [
            { index: 1, prior: 10, next: 30 }, // above → +20
            { index: 3, prior: 10, next: 5 }, // above (shrink) → -5
            { index: 80, prior: 10, next: 100 }, // below the fold → ignored
          ],
          prefix,
          100,
          0,
        ),
      ).toBe(15);
    });

    it('accounts for regionTop (padding + load-older banner) at the fold', () => {
      // Row 8 (offset 80, bottom 90): above scrollTop 100 with no region offset…
      expect(
        scrollCompensation([{ index: 8, prior: 10, next: 30 }], prefix, 100, 0),
      ).toBe(20);
      // …but with a 52px region offset (16 padding + 36 banner) its physical bottom
      // is 142 > 100, so it straddles the fold and must NOT be compensated.
      expect(
        scrollCompensation(
          [{ index: 8, prior: 10, next: 30 }],
          prefix,
          100,
          52,
        ),
      ).toBe(0);
    });

    it('is empty-safe', () => {
      expect(scrollCompensation([], prefix, 100, 0)).toBe(0);
    });
  });
});
