import { describe, expect, it } from 'vitest';
import * as nativeClient from '../e2e/android/account-workspace-client.mts';

const before = {
  scrollTop: 204.1904754638672,
  scrollHeight: 620,
  clientHeight: 416,
};
const rebased = {
  scrollTop: 783.6190185546875,
  scrollHeight: 1400,
  clientHeight: 416,
};
const moved = (...args) => {
  expect(nativeClient.nativeSwipeAdvanced).toBeTypeOf('function');
  return nativeClient.nativeSwipeAdvanced(...args);
};

describe('native swipe position reference', () => {
  it('preserves strict top-offset checking by default', () => {
    expect(moved(before, rebased, 'decrease-scroll-top')).toBe(false);
    expect(
      moved(before, { ...before, scrollTop: 100 }, 'decrease-scroll-top'),
    ).toBe(true);
    expect(
      moved({ ...before, scrollTop: 100 }, before, 'increase-scroll-top'),
    ).toBe(true);
    expect(moved(before, before, 'decrease-scroll-top')).toBe(false);
  });

  it('proves the observed older-history movement despite a prepend rebase', () => {
    expect(moved(before, rebased, 'decrease-scroll-top', 'bottom')).toBe(true);
    expect(moved(before, rebased, 'increase-scroll-top', 'bottom')).toBe(false);
  });

  it('rejects content growth with only anchor preservation and no native progress', () => {
    const stationary = {
      ...before,
      scrollHeight: 1400,
      scrollTop: before.scrollTop + 780,
    };
    expect(moved(before, stationary, 'decrease-scroll-top', 'bottom')).toBe(
      false,
    );
    expect(moved(before, stationary, 'increase-scroll-top', 'bottom')).toBe(
      false,
    );
  });

  it('requires the correct direction without a content-height change', () => {
    expect(
      moved(
        before,
        { ...before, scrollTop: 100 },
        'decrease-scroll-top',
        'bottom',
      ),
    ).toBe(true);
    expect(
      moved(
        { ...before, scrollTop: 100 },
        before,
        'increase-scroll-top',
        'bottom',
      ),
    ).toBe(true);
    expect(moved(before, before, 'decrease-scroll-top', 'bottom')).toBe(false);
  });

  it('rejects height-only growth and subpixel layout drift without native displacement', () => {
    expect(
      moved(
        before,
        { ...before, scrollHeight: 700 },
        'decrease-scroll-top',
        'bottom',
      ),
    ).toBe(false);
    expect(
      moved(
        before,
        { ...before, scrollTop: before.scrollTop - 1 },
        'decrease-scroll-top',
        'bottom',
      ),
    ).toBe(false);
    expect(
      moved(
        before,
        { ...before, scrollHeight: 700, scrollTop: before.scrollTop + 1 },
        'decrease-scroll-top',
        'bottom',
      ),
    ).toBe(false);
  });

  it.each([
    { scrollTop: NaN },
    { scrollHeight: Infinity },
    { clientHeight: 0 },
    { clientHeight: 400 },
    { clientHeight: 415 },
    { scrollHeight: 20 },
  ])('rejects invalid or changed-viewport measurements %j', (patch) => {
    expect(() =>
      moved(before, { ...rebased, ...patch }, 'decrease-scroll-top', 'bottom'),
    ).toThrow();
  });
});
