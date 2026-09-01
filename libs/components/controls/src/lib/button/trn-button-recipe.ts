import type { TrnSize, TrnVariant } from '@trinity/components/foundations';
import { buttonVariants } from '@trinity/helm/button';

export type TrnButtonVariant = Extract<
  TrnVariant,
  'primary' | 'secondary' | 'danger'
>;
export type TrnButtonSize = Extract<TrnSize, 'xs' | 'sm' | 'md' | 'lg'>;
export type TrnButtonPresentation = 'solid' | 'outline' | 'ghost' | 'link';
export type TrnButtonShape = 'label' | 'icon';

type LegacyButtonVariant =
  'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link';
type LegacyButtonSize =
  'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg';

export type TrnButtonVariantInput = TrnButtonVariant | LegacyButtonVariant;
export type TrnButtonSizeInput = TrnButtonSize | LegacyButtonSize;

interface TrnButtonRecipeOptions {
  presentation: TrnButtonPresentation;
  shape: TrnButtonShape;
  size: TrnButtonSizeInput;
  variant: TrnButtonVariantInput;
}

const solidVariant = {
  primary: 'default',
  secondary: 'secondary',
  danger: 'destructive',
} as const;

const labelSize = {
  xs: 'xs',
  sm: 'sm',
  md: 'default',
  lg: 'lg',
} as const;

const iconSize = {
  xs: 'icon-xs',
  sm: 'icon-sm',
  md: 'icon',
  lg: 'icon-lg',
} as const;

function isCanonicalVariant(
  variant: TrnButtonVariantInput,
): variant is TrnButtonVariant {
  return (
    variant === 'primary' || variant === 'secondary' || variant === 'danger'
  );
}

function isCanonicalSize(size: TrnButtonSizeInput): size is TrnButtonSize {
  return size === 'xs' || size === 'sm' || size === 'md' || size === 'lg';
}

export function isTrnButtonIconSize(size: TrnButtonSizeInput): boolean {
  return size.startsWith('icon');
}

/**
 * A private adapter from Trinity concepts to the current Helm class substrate.
 *
 * No Helm or CVA type crosses the public Controls entrypoint. When the substrate changes,
 * only this mapping changes; canonical component callers keep their semantic vocabulary.
 */
export function trnButtonRecipe(options: TrnButtonRecipeOptions): string {
  const variant = isCanonicalVariant(options.variant)
    ? options.presentation === 'solid'
      ? solidVariant[options.variant]
      : options.presentation
    : options.variant;

  const size = isCanonicalSize(options.size)
    ? options.shape === 'icon'
      ? iconSize[options.size]
      : labelSize[options.size]
    : options.size;

  return buttonVariants({ variant, size });
}
