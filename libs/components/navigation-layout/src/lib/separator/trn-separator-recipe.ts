import type { TrnVariant } from '@trinity/components/foundations';
import { hlm } from '@trinity/helm/utils';

export type TrnSeparatorVariant = Extract<TrnVariant, 'neutral' | 'accent'>;

const variantRecipe = {
  neutral: 'bg-[var(--trinity-border-control)]',
  accent: 'bg-[var(--trinity-state-attention-surface)]',
} as const;

export function trnSeparatorRecipe(variant: TrnSeparatorVariant): string {
  return hlm(
    'inline-flex shrink-0 data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch',
    variantRecipe[variant],
  );
}
