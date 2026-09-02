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

interface TrnButtonRecipeOptions {
  presentation: TrnButtonPresentation;
  shape: TrnButtonShape;
  size: TrnButtonSize;
  variant: TrnButtonVariant;
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
      'text-secondary-foreground hover:bg-secondary dark:hover:bg-secondary hover:text-secondary-foreground dark:hover:text-secondary-foreground',
    ghost:
      'text-secondary-foreground hover:bg-secondary dark:hover:bg-secondary hover:text-secondary-foreground dark:hover:text-secondary-foreground',
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

/**
 * A private adapter from Trinity concepts to the current Helm class substrate.
 *
 * No Helm or CVA type crosses the public Controls entrypoint. When the substrate changes,
 * only this mapping changes; canonical component callers keep their semantic vocabulary.
 */
export function trnButtonRecipe(options: TrnButtonRecipeOptions): string {
  const size =
    options.shape === 'icon' ? iconSize[options.size] : labelSize[options.size];
  const variant =
    options.presentation === 'solid'
      ? solidVariant[options.variant]
      : options.presentation;
  const tone =
    options.presentation === 'solid'
      ? ''
      : nonSolidTone[options.variant][options.presentation];

  return hlm(buttonVariants({ variant, size }), tone);
}
