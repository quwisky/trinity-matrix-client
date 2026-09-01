import type { TrnSize, TrnVariant } from '@trinity/components/foundations';
import { buttonVariants } from '@trinity/helm/button';
import { hlm } from '@trinity/helm/utils';

export type TrnButtonVariant = Extract<
  TrnVariant,
  'primary' | 'secondary' | 'danger'
>;
export type TrnButtonSize = Extract<TrnSize, 'xs' | 'sm' | 'md' | 'lg'>;
export type TrnButtonPresentation = 'solid' | 'outline' | 'ghost' | 'link';
export type TrnButtonShape = 'label' | 'icon';

type LegacyButtonVariant =
  'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link';
type LegacyPresentationVariant = Extract<
  LegacyButtonVariant,
  TrnButtonPresentation
>;
type SemanticButtonVariantInput =
  TrnButtonVariant | Extract<LegacyButtonVariant, 'default' | 'destructive'>;
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

const nonSolidTone = {
  primary: {
    outline: '',
    ghost: '',
    link: '',
  },
  secondary: {
    outline:
      'text-secondary-foreground hover:bg-secondary hover:text-secondary-foreground',
    ghost:
      'text-secondary-foreground hover:bg-secondary hover:text-secondary-foreground',
    link: 'text-secondary-foreground',
  },
  danger: {
    outline:
      'border-danger text-danger hover:bg-[var(--trinity-danger-tint-10)] dark:hover:bg-[var(--trinity-danger-tint-10)] hover:text-danger',
    ghost:
      'text-danger hover:bg-[var(--trinity-danger-tint-10)] dark:hover:bg-[var(--trinity-danger-tint-10)] hover:text-danger',
    link: 'text-danger hover:text-danger',
  },
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

function isLegacyPresentationVariant(
  variant: TrnButtonVariantInput,
): variant is LegacyPresentationVariant {
  return variant === 'outline' || variant === 'ghost' || variant === 'link';
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
  const { tone, variant } = resolveVariant(options);
  const canonicalSize = normalizeSize(options.size);
  const shape = isTrnButtonIconSize(options.size) ? 'icon' : options.shape;
  const size =
    shape === 'icon' ? iconSize[canonicalSize] : labelSize[canonicalSize];

  return hlm(buttonVariants({ variant, size }), tone);
}

function resolveVariant(options: TrnButtonRecipeOptions): {
  tone: string;
  variant: LegacyButtonVariant;
} {
  if (isLegacyPresentationVariant(options.variant)) {
    return { tone: '', variant: options.variant };
  }
  const semanticVariant = normalizeVariant(options.variant);

  if (options.presentation === 'solid') {
    return { tone: '', variant: solidVariant[semanticVariant] };
  }

  return {
    tone: nonSolidTone[semanticVariant][options.presentation],
    variant: options.presentation,
  };
}

function normalizeVariant(
  variant: SemanticButtonVariantInput,
): TrnButtonVariant {
  if (isCanonicalVariant(variant)) {
    return variant;
  }

  switch (variant) {
    case 'default':
      return 'primary';
    case 'destructive':
      return 'danger';
  }
}

function normalizeSize(size: TrnButtonSizeInput): TrnButtonSize {
  if (isCanonicalSize(size)) {
    return size;
  }

  switch (size) {
    case 'default':
    case 'icon':
      return 'md';
    case 'icon-xs':
      return 'xs';
    case 'icon-sm':
      return 'sm';
    case 'icon-lg':
      return 'lg';
  }
}
