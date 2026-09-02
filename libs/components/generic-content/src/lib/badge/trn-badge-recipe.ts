import type { TrnSize, TrnVariant } from '@trinity/components/foundations';
import { badgeVariants } from '@trinity/helm/badge';
import { hlm as trn } from '@trinity/helm/utils';

/** Semantic status treatments supported by Trinity badges. */
export type TrnBadgeVariant = Extract<
  TrnVariant,
  'neutral' | 'success' | 'warning'
>;

/** Compact badge geometry; badges never grow to control or display sizes. */
export type TrnBadgeSize = Extract<TrnSize, 'xs' | 'sm' | 'md'>;

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

/** Private vendor adapter: callers receive only Trinity variant and size names. */
export function trnBadgeRecipe(
  variant: TrnBadgeVariant,
  size: TrnBadgeSize,
): string {
  return trn(
    badgeVariants({ variant: 'outline' }),
    variantClasses[variant],
    sizeClasses[size],
  );
}
