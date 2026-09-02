import type { TrnSize } from '@trinity/components/foundations';
import { hlm } from '@trinity/helm/utils';

export type TrnTextControlSize = Extract<TrnSize, 'sm' | 'md' | 'lg'>;

const inputSize = {
  sm: 'min-h-[max(1.75rem,var(--trinity-interaction-target-min-size))] px-2 py-1 text-xs',
  md: 'min-h-[max(var(--trinity-density-control-size),var(--trinity-interaction-target-min-size))] px-2.5 py-1 text-[length:var(--trinity-type-control-size)]',
  lg: 'min-h-[max(2.5rem,var(--trinity-interaction-target-min-size))] px-3 py-2 text-base',
} as const;

const textareaSize = {
  sm: 'min-h-14 px-2 py-1.5 text-sm',
  md: 'min-h-16 px-2.5 py-2 text-[length:var(--trinity-type-control-size)]',
  lg: 'min-h-20 px-3 py-2.5 text-base',
} as const;

const base =
  'w-full min-w-0 rounded-[var(--trinity-shape-control-radius)] border border-[var(--trinity-border-strong)] bg-transparent text-[var(--trinity-text-bright)] outline-none transition-[background-color,border-color,box-shadow] placeholder:text-[var(--trinity-text-muted)] focus-visible:border-[var(--trinity-focus-ring)] focus-visible:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-focus-ring)] data-[matches-spartan-invalid=true]:border-danger data-[matches-spartan-invalid=true]:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-danger)] disabled:cursor-not-allowed disabled:bg-[var(--trinity-surface-raised)] disabled:opacity-[var(--trinity-disabled-opacity)]';

export function trnInputRecipe(
  size: TrnTextControlSize,
  invalid = false,
): string {
  return hlm(
    base,
    'file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-[var(--trinity-text-bright)]',
    inputSize[size],
    invalid
      ? 'border-danger shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-danger)]'
      : '',
  );
}

export function trnTextareaRecipe(
  size: TrnTextControlSize,
  invalid = false,
): string {
  return hlm(
    base,
    'flex field-sizing-content',
    textareaSize[size],
    invalid
      ? 'border-danger shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-danger)]'
      : '',
  );
}
