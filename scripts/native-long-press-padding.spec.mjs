import { describe, expect, it } from 'vitest';
import * as nativeClient from '../e2e/android/account-workspace-client.mts';

// Measured grouped row: no avatar/select-none child, 16px left padding.
const geometry = {
  row: { left: 0, top: 574, right: 385, bottom: 624 },
  scroller: { left: 0, top: 216, right: 393, bottom: 632 },
  viewport: { width: 393, height: 727 },
  paddingLeft: 16,
  textRects: [
    { left: 12, top: 590, right: 56, bottom: 606 },
    { left: 68, top: 574, right: 360, bottom: 622 },
  ],
  blockingRects: [],
};
const candidates = (value = geometry) => {
  expect(nativeClient.nativeLongPressPaddingCandidates).toBeTypeOf('function');
  return nativeClient.nativeLongPressPaddingCandidates(value);
};

describe('native long-press blank-padding geometry', () => {
  it('finds measured padding outside timestamp/body glyphs with a rounding envelope', () => {
    expect(candidates()).toEqual([
      {
        cssPoint: { x: 8, y: 578 },
        bounds: { left: 6, top: 576, right: 10, bottom: 580 },
      },
      {
        cssPoint: { x: 8, y: 620 },
        bounds: { left: 6, top: 618, right: 10, bottom: 622 },
      },
    ]);
  });

  it('rejects glyphs within eight pixels of any part of the gesture envelope', () => {
    expect(
      candidates({
        ...geometry,
        textRects: [
          ...geometry.textRects,
          { left: 18, top: 574, right: 30, bottom: 624 },
        ],
      }),
    ).toEqual([]);
  });

  it('rejects media/control rectangles even without text', () => {
    expect(candidates({ ...geometry, blockingRects: [geometry.row] })).toEqual(
      [],
    );
  });

  it('never escapes the row scroller or physical viewport', () => {
    expect(
      candidates({ ...geometry, scroller: { ...geometry.scroller, top: 580 } }),
    ).toEqual([
      {
        cssPoint: { x: 8, y: 620 },
        bounds: { left: 6, top: 618, right: 10, bottom: 622 },
      },
    ]);
    expect(
      candidates({ ...geometry, viewport: { width: 393, height: 575 } }),
    ).toEqual([]);
    expect(
      candidates({ ...geometry, scroller: { ...geometry.scroller, left: 10 } }),
    ).toEqual([]);
  });

  it.each([
    { paddingLeft: 0 },
    { paddingLeft: 11 },
    { paddingLeft: NaN },
    { viewport: { width: Infinity, height: 727 } },
    { row: { ...geometry.row, bottom: 574 } },
    { textRects: [{ left: NaN, top: 0, right: 10, bottom: 20 }] },
  ])(
    'fails closed for invalid or insufficient measured geometry %j',
    (patch) => {
      expect(candidates({ ...geometry, ...patch })).toEqual([]);
    },
  );
});
