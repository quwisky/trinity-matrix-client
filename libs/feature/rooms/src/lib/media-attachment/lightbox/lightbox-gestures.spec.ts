import { describe, expect, it } from 'vitest';
import {
  DOUBLE_TAP_SCALE,
  MAX_SCALE,
  REST_VIEW,
  backdropOpacity,
  clampScale,
  clampView,
  doubleTapView,
  isDoubleTap,
  isTap,
  shouldDismiss,
  zoomAbout,
} from './lightbox-gestures';

const box = { width: 400, height: 800 };

describe('lightbox gestures', () => {
  it('clamps zoom between rest and the maximum', () => {
    expect(clampScale(0.4)).toBe(1);
    expect(clampScale(9)).toBe(MAX_SCALE);
    expect(clampScale(2)).toBe(2);
  });

  it('allows no pan at rest and half the overshoot when zoomed', () => {
    const rest = clampView({ scale: 1, x: 50, y: -50 }, box);
    expect(rest.scale).toBe(1);
    expect(rest.x).toBeCloseTo(0);
    expect(rest.y).toBeCloseTo(0);
    expect(clampView({ scale: 2, x: 999, y: -999 }, box)).toEqual({
      scale: 2,
      x: 200,
      y: -400,
    });
  });

  it('keeps the point under the focal position fixed when zooming', () => {
    const focal = { x: 100, y: -60 };
    const next = zoomAbout(REST_VIEW, 2, focal);
    // The image point under the finger is (focal - translate) / scale, before and after.
    expect((focal.x - next.x) / next.scale).toBeCloseTo(focal.x);
    expect((focal.y - next.y) / next.scale).toBeCloseTo(focal.y);
  });

  it('double tap zooms in on the point, then back to rest', () => {
    const zoomed = doubleTapView(REST_VIEW, { x: 50, y: 0 });
    expect(zoomed.scale).toBe(DOUBLE_TAP_SCALE);
    expect(doubleTapView(zoomed, { x: 0, y: 0 })).toEqual(REST_VIEW);
  });

  it('tells a tap from a drag or a hold', () => {
    expect(isTap(3, 120)).toBe(true);
    expect(isTap(30, 120)).toBe(false);
    expect(isTap(3, 700)).toBe(false);
  });

  it('pairs two close, quick taps', () => {
    const first = { at: 1000, point: { x: 100, y: 100 } };
    expect(isDoubleTap(null, 1100, { x: 100, y: 100 })).toBe(false);
    expect(isDoubleTap(first, 1200, { x: 110, y: 105 })).toBe(true);
    expect(isDoubleTap(first, 1500, { x: 100, y: 100 })).toBe(false);
    expect(isDoubleTap(first, 1200, { x: 300, y: 100 })).toBe(false);
  });

  it('dismisses on a long swipe or a quick flick, not a short slow one', () => {
    expect(shouldDismiss(200, 800, 800)).toBe(true);
    expect(shouldDismiss(60, 80, 800)).toBe(true);
    expect(shouldDismiss(60, 600, 800)).toBe(false);
    expect(shouldDismiss(20, 10, 800)).toBe(false);
  });

  it('dims the backdrop as the image is dragged, never fully', () => {
    expect(backdropOpacity(0, 800)).toBe(1);
    expect(backdropOpacity(400, 800)).toBe(0.5);
    expect(backdropOpacity(800, 800)).toBe(0.3);
  });
});
