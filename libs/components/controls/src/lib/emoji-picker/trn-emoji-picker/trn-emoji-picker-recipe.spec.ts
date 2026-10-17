import { describe, expect, it } from 'vitest';
import { trnEmojiGridFit } from './trn-emoji-picker-recipe';

describe('trnEmojiGridFit', () => {
  it('keeps the fixed grid: nine 32px cells in the 288px row of the medium picker', () => {
    expect(trnEmojiGridFit(288, 20, 32)).toEqual({
      perLine: 9,
      glyph: 20,
      padding: 6,
    });
  });

  it('fills a phone sheet with as many 44px touch cells as fit, widened to share the slack', () => {
    // 390px sheet less 12px each side: 366px of row, eight 45px cells. A 24px glyph would
    // pad by 10.5px, so it grows to 25px and pads by a whole 10px.
    expect(trnEmojiGridFit(366, 24, 44)).toEqual({
      perLine: 8,
      glyph: 25,
      padding: 10,
    });
  });

  it('adds columns as the row widens, as on rotation', () => {
    expect(trnEmojiGridFit(820, 24, 44)).toEqual({
      perLine: 18,
      glyph: 25,
      padding: 10,
    });
  });

  it('fills the desktop card: 8px insets and an 8px scrollbar leave 276px for 34px cells', () => {
    // 302px card less its 1px border, 8px insets and the scrollbar gutter.
    expect(trnEmojiGridFit(276, 20, 0)).toEqual({
      perLine: 8,
      glyph: 20,
      padding: 7,
    });
  });

  it('keeps every glyph on a whole pixel, moving it by a pixel to match the cell', () => {
    // 300 / 9 = 33px cells would pad a 20px glyph by 6.5px.
    expect(trnEmojiGridFit(300, 20, 0)).toEqual({
      perLine: 9,
      glyph: 21,
      padding: 6,
    });
  });

  it('shrinks the glyph instead where a larger one would crowd the cell', () => {
    // A 31px cell has room for a 19px glyph at 6px, not a 21px one.
    expect(trnEmojiGridFit(31, 20, 0)).toEqual({
      perLine: 1,
      glyph: 19,
      padding: 6,
    });
  });

  it('never asks for a cell smaller than the glyph and its own padding', () => {
    expect(trnEmojiGridFit(366, 24, 20).perLine).toBe(10);
  });

  it('keeps at least one column on a row narrower than a cell', () => {
    expect(trnEmojiGridFit(30, 24, 44)).toEqual({
      perLine: 1,
      glyph: 24,
      padding: 3,
    });
  });
});
