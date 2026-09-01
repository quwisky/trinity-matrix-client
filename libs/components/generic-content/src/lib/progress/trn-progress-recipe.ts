import type { TrnSize, TrnVariant } from '@trinity/components/foundations';

export type TrnProgressVariant = Extract<
  TrnVariant,
  'accent' | 'success' | 'warning' | 'danger'
>;
export type TrnProgressSize = Extract<TrnSize, 'xs' | 'sm' | 'md'>;

const trackSizeClasses = {
  xs: 'h-0.5',
  sm: 'h-1',
  md: 'h-1.5',
} as const satisfies Record<TrnProgressSize, string>;

const indicatorVariantClasses = {
  accent: 'bg-[var(--trinity-state-attention-surface)]',
  success: 'bg-[var(--trinity-status-success-surface)]',
  warning: 'bg-[var(--trinity-status-warning-surface)]',
  danger: 'bg-[var(--trinity-status-danger-surface)]',
} as const satisfies Record<TrnProgressVariant, string>;

/** Full track recipe; the consumer class remains free for external layout only. */
export function trnProgressTrackRecipe(size: TrnProgressSize): string {
  return `relative inline-flex w-full overflow-hidden rounded-full bg-[var(--trinity-status-neutral-surface)] ${trackSizeClasses[size]}`;
}

/** Semantic fill recipe; determinate/indeterminate remains a behavior, not a variant. */
export function trnProgressIndicatorRecipe(
  variant: TrnProgressVariant,
): string {
  return `h-full w-full flex-1 transition-all ${indicatorVariantClasses[variant]}`;
}
