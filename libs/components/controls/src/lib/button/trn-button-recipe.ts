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

/**
 * Helm's `destructive` variant is a 10% tint, which reads weaker than the outlined Cancel
 * beside it. Trinity's solid danger is a filled confirm. The `dark:` classes override
 * Helm's own `dark:bg-destructive/20` and `dark:hover:bg-destructive/30`.
 */
const solidDangerTone =
  'bg-[color:var(--trinity-danger-solid)] dark:bg-[color:var(--trinity-danger-solid)] text-[color:var(--trinity-danger-solid-foreground)] hover:bg-[color:var(--trinity-danger-solid-hover)] dark:hover:bg-[color:var(--trinity-danger-solid-hover)]';

/** Outline buttons share the text-field border; Helm's `--border` is too faint (1.39:1). */
const controlBorder =
  'border-[color:var(--trinity-border-control)] dark:border-[color:var(--trinity-border-control)]';

const nonSolidTone = {
  primary: {
    outline: controlBorder,
    ghost: '',
    link: '',
  },
  secondary: {
    outline: `${controlBorder} text-secondary-foreground hover:bg-secondary dark:hover:bg-secondary hover:text-secondary-foreground dark:hover:text-secondary-foreground`,
    ghost:
      'text-secondary-foreground hover:bg-secondary dark:hover:bg-secondary hover:text-secondary-foreground dark:hover:text-secondary-foreground',
    link: 'text-secondary-foreground',
  },
  danger: {
    outline:
      'border-danger dark:border-danger text-danger hover:bg-[var(--trinity-danger-tint-10)] dark:hover:bg-[var(--trinity-danger-tint-10)] hover:text-danger',
    ghost:
      'text-danger hover:bg-[var(--trinity-danger-tint-10)] dark:hover:bg-[var(--trinity-danger-tint-10)] hover:text-danger',
    link: 'text-danger hover:text-danger',
  },
} as const;

/** One keyboard-focus ring for every button, matching `trnInput` and the global baseline. */
const focusRing =
  'focus-visible:border-[color:var(--trinity-focus-ring)] focus-visible:ring-[color:var(--trinity-focus-ring)] dark:focus-visible:ring-[color:var(--trinity-focus-ring)]';

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
      ? options.variant === 'danger'
        ? solidDangerTone
        : ''
      : nonSolidTone[options.variant][options.presentation];

  return hlm(buttonVariants({ variant, size }), tone, focusRing);
}
