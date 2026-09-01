/**
 * The semantic treatments available to Trinity component recipes.
 *
 * Components expose an `Extract`-based subset rather than accepting this whole catalog.
 * Structural choices such as outline presentation or icon geometry belong to separate,
 * component-owned inputs.
 */
export const TRN_VARIANTS = [
  'primary',
  'secondary',
  'neutral',
  'accent',
  'muted',
  'danger',
  'success',
  'warning',
] as const;

export type TrnVariant = (typeof TRN_VARIANTS)[number];

/** The shared ordinal scale from which each component selects supported sizes. */
export const TRN_SIZES = ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'] as const;

export type TrnSize = (typeof TRN_SIZES)[number];
