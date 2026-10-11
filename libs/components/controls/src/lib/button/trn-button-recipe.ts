import type { TrnSize, TrnVariant } from '@trinity/components/foundations';
import { buttonVariants } from '@trinity/helm/button';
import { hlm } from '@trinity/helm/utils';

export type TrnButtonVariant = Extract<
  TrnVariant,
  'primary' | 'secondary' | 'danger'
>;
export type TrnButtonSize = Extract<TrnSize, 'xs' | 'sm' | 'md' | 'lg'>;
export type TrnButtonPresentation = 'solid' | 'outline' | 'ghost' | 'link';
export type TrnButtonShape = 'label' | 'icon' | 'row';

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

/**
 * A solid primary action on an attention surface (an accent `trn-banner`, which marks itself
 * `data-trn-surface="attention"`). Its own fill is the accent, the same colour as that
 * surface, so it would read as plain text with no visible hover (#1217). There it inverts to
 * the attention action roles, and its focus ring gains an offset in the surface colour so the
 * ring, which shares the fill's colour, stays distinct from the button. Outside such a surface
 * none of these classes match, so every other solid primary button is unchanged.
 *
 * Anchors need their own hover class: Helm's `[a]:hover:bg-primary/80` compiles to
 * `.cls:is(a):hover`, which outranks the plain attention hover. The `[a]:` copy has equal
 * specificity and is emitted after Helm's, so it wins.
 */
const solidPrimaryOnAttention =
  'in-data-[trn-surface=attention]:bg-[color:var(--trinity-state-attention-action-surface)] in-data-[trn-surface=attention]:text-[color:var(--trinity-state-attention-action-foreground)] in-data-[trn-surface=attention]:hover:bg-[color:var(--trinity-state-attention-action-hover-surface)] in-data-[trn-surface=attention]:[a]:hover:bg-[color:var(--trinity-state-attention-action-hover-surface)] in-data-[trn-surface=attention]:focus-visible:ring-offset-[length:var(--trinity-focus-ring-offset)] in-data-[trn-surface=attention]:focus-visible:ring-offset-[color:var(--trinity-state-attention-surface)]';

const solidTone = {
  primary: solidPrimaryOnAttention,
  secondary: '',
  danger: solidDangerTone,
} as const;

/** Outline buttons share the text-field border; Helm's `--border` is too faint (1.39:1). */
const controlBorder =
  'border-[color:var(--trinity-border-control)] dark:border-[color:var(--trinity-border-control)]';

// `dark:hover:bg-*` stays: it out-merges Helm's own `dark:hover:bg-input/50` (outline) and
// `dark:hover:bg-muted/50` (ghost). Without it, Helm's dark hover fill wins in dark mode.
const nonSolidTone = {
  primary: {
    outline: controlBorder,
    ghost: '',
    link: '',
  },
  secondary: {
    outline: `${controlBorder} text-secondary-foreground hover:bg-secondary dark:hover:bg-secondary hover:text-secondary-foreground`,
    ghost:
      'text-secondary-foreground hover:bg-secondary dark:hover:bg-secondary hover:text-secondary-foreground',
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

/**
 * One keyboard-focus ring for every button, matching `trnInput` and the global baseline.
 * `dark:focus-visible:ring-*` out-merges Helm destructive's `dark:focus-visible:ring-destructive/40`.
 */
const focusRing =
  'focus-visible:border-[color:var(--trinity-focus-ring)] focus-visible:ring-[color:var(--trinity-focus-ring)] dark:focus-visible:ring-[color:var(--trinity-focus-ring)]';

/** A full-width list row: the label starts at the inline start and wraps instead of clipping. */
const rowShape = 'h-auto w-full justify-start text-start whitespace-normal';

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
      ? solidTone[options.variant]
      : nonSolidTone[options.variant][options.presentation];

  return hlm(
    buttonVariants({ variant, size }),
    options.shape === 'row' ? rowShape : '',
    tone,
    focusRing,
  );
}
