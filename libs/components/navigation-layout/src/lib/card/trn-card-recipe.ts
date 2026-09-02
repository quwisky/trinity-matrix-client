import type { TrnSize, TrnVariant } from '@trinity/components/foundations';
import { hlm } from '@trinity/helm/utils';

export type TrnCardVariant = Extract<TrnVariant, 'neutral' | 'muted'>;
export type TrnCardSize = Extract<TrnSize, 'sm' | 'md'>;

const variantRecipe = {
  neutral:
    'bg-[var(--trinity-surface-card)] text-[var(--trinity-control-foreground)] ring-[var(--trinity-border-subtle)]',
  muted:
    'bg-[var(--trinity-surface-raised)] text-[var(--trinity-text-bright)] ring-[var(--trinity-border-subtle)]',
} as const;

const sizeRecipe = {
  sm: '[--card-spacing:--spacing(3)]',
  md: '[--card-spacing:--spacing(4)]',
} as const;

export function trnCardRecipe(
  variant: TrnCardVariant,
  size: TrnCardSize,
): string {
  return hlm(
    'group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl py-(--card-spacing) text-sm ring-1 has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl',
    variantRecipe[variant],
    sizeRecipe[size],
  );
}
