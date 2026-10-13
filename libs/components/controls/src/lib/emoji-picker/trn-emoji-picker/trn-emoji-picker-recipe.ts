import type { TrnSize } from '@trinity/components/foundations';

export type TrnEmojiPickerSize = Extract<TrnSize, 'sm' | 'md' | 'lg'>;

const glyphSize = {
  sm: 18,
  md: 20,
  lg: 24,
} as const;

/** Maps Trinity's ordinal picker size to the private vendor glyph measurement. */
export function trnEmojiPickerGlyphSize(size: TrnEmojiPickerSize): number {
  return glyphSize[size];
}

/** The vendor pads every emoji cell by 6px on each side of its glyph. */
export const VENDOR_CELL_PADDING = 6;

/** A touch target's minimum side, in px. */
export const TRN_EMOJI_TOUCH_CELL = 44;

export interface TrnEmojiGridFit {
  /** Emoji per line: the vendor's `perLine`, which also sizes its frequently-used row. */
  readonly perLine: number;
  /** Padding around each glyph, so the cells share the row's width between them. */
  readonly padding: number;
}

/**
 * Fits whole emoji cells across a row of `rowWidth` px: as many as fit at the larger of the
 * vendor's own cell (the glyph and its 6px padding) and `minCell`, each then widened to share
 * the leftover. Cells stay whole pixels, so a row never wraps on rounding.
 */
export function trnEmojiGridFit(
  rowWidth: number,
  glyph: number,
  minCell: number,
): TrnEmojiGridFit {
  const target = Math.max(glyph + 2 * VENDOR_CELL_PADDING, minCell);
  const perLine = Math.max(1, Math.floor(rowWidth / target));
  const cell = Math.floor(rowWidth / perLine);
  return { perLine, padding: (cell - glyph) / 2 };
}
