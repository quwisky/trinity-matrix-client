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
