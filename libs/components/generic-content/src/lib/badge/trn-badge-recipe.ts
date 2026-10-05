import type { TrnSize, TrnVariant } from '@trinity/components/foundations';
import { hlm as trn } from '@trinity/helm/utils';

/** Semantic status treatments supported by Trinity badges. */
export type TrnBadgeVariant = Extract<
  TrnVariant,
  'neutral' | 'success' | 'warning'
>;

/** Compact badge geometry; badges never grow to control or display sizes. */
export type TrnBadgeSize = Extract<TrnSize, 'xs' | 'sm' | 'md'>;

// Trinity badges are semantic pills, independent of Tailwind's numeric radius scale.
const baseClasses =
  'h-5 gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground transition-all has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&>ng-icon]:text-[length:--spacing(3)] group/badge focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 inline-flex w-fit shrink-0 items-center justify-center overflow-hidden whitespace-nowrap focus-visible:ring-[3px] [&>ng-icon]:pointer-events-none [a]:hover:bg-muted [a]:hover:text-muted-foreground';

const variantClasses = {
  neutral:
    'border-transparent bg-[var(--trinity-status-neutral-surface)] text-[var(--trinity-status-neutral-foreground)]',
  success:
    'border-transparent bg-[var(--trinity-status-success-surface)] text-[var(--trinity-status-success-surface-foreground)]',
  warning:
    'border-transparent bg-[var(--trinity-status-warning-surface)] text-[var(--trinity-status-warning-surface-foreground)]',
} as const satisfies Record<TrnBadgeVariant, string>;

const sizeClasses = {
  xs: 'h-4 gap-0.5 px-1.5 py-0 text-xs',
  sm: 'h-5 gap-1 px-2 py-0.5 text-xs',
  md: 'h-6 gap-1 px-2.5 py-1 text-xs',
} as const satisfies Record<TrnBadgeSize, string>;

/** Callers receive only Trinity variant and size names. */
export function trnBadgeRecipe(
  variant: TrnBadgeVariant,
  size: TrnBadgeSize,
): string {
  return trn(baseClasses, variantClasses[variant], sizeClasses[size]);
}
