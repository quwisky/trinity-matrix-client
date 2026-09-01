import type { TrnSize, TrnVariant } from '../style/trn-recipe-vocabulary';

/** Semantic treatments that make sense for a glyph drawn on an ordinary surface. */
export type TrnIconVariant = Extract<
  TrnVariant,
  'neutral' | 'accent' | 'muted' | 'danger'
>;

/** The complete ordinal icon scale. Icons may appear from metadata through empty states. */
export type TrnIconSize = Extract<
  TrnSize,
  '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
>;

type CssLengthUnit = 'px' | 'rem' | 'em';
type LegacyIconSize = `${number}${CssLengthUnit}`;

export type TrnIconSizeInput = TrnIconSize | LegacyIconSize;

const iconSize = {
  '2xs': '0.75rem',
  xs: '0.875rem',
  sm: '1rem',
  md: '1.125rem',
  lg: '1.25rem',
  xl: '1.5rem',
  '2xl': '2rem',
} as const satisfies Record<TrnIconSize, string>;

function isTrnIconSize(size: TrnIconSizeInput): size is TrnIconSize {
  return size in iconSize;
}

/** Resolves canonical sizes while retaining exact CSS-length inputs during expansion. */
export function resolveTrnIconSize(size: TrnIconSizeInput | null): string {
  if (size === null) {
    return '';
  }

  return isTrnIconSize(size) ? iconSize[size] : size;
}
