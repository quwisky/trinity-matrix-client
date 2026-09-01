import type { TrnSize, TrnVariant } from '@trinity/components/foundations';

export type TrnSpinnerVariant = Extract<
  TrnVariant,
  'neutral' | 'muted' | 'accent' | 'danger'
>;
export type TrnSpinnerSize = Extract<TrnSize, 'xs' | 'sm' | 'md' | 'lg'>;

const sizeClasses = {
  xs: 'text-[length:--spacing(3)]',
  sm: 'text-[length:--spacing(3.5)]',
  md: 'text-[length:--spacing(4)]',
  lg: 'text-[length:--spacing(5)]',
} as const satisfies Record<TrnSpinnerSize, string>;

const variantClasses = {
  neutral: 'text-[var(--trinity-text)]',
  muted: 'text-[var(--trinity-text-muted)]',
  accent: 'text-[var(--trinity-link)]',
  danger: 'text-[var(--trinity-danger)]',
} as const satisfies Record<TrnSpinnerVariant, string>;

/** Full inner recipe. A null variant deliberately inherits the surrounding control ink. */
export function trnSpinnerRecipe(
  size: TrnSpinnerSize,
  variant: TrnSpinnerVariant | null,
): string {
  return [
    'inline-flex motion-safe:animate-spin',
    sizeClasses[size],
    variant === null ? null : variantClasses[variant],
  ]
    .filter((value): value is string => value !== null)
    .join(' ');
}
