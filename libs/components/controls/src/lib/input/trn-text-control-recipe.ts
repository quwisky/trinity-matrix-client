import type { TrnSize } from '@trinity/components/foundations';
import { hlm } from '@trinity/helm/utils';

export type TrnTextControlSize = Extract<TrnSize, 'sm' | 'md' | 'lg'>;

const inputSize = {
  sm: 'min-h-[max(1.75rem,var(--trinity-interaction-target-min-size))] px-2 py-1 text-xs',
  md: 'min-h-[max(var(--trinity-density-control-size),var(--trinity-interaction-target-min-size))] px-2.5 py-1 text-[length:var(--trinity-type-control-size)]',
  lg: 'min-h-[max(2.5rem,var(--trinity-interaction-target-min-size))] px-3 py-2 text-base [--trinity-entry-font-size:var(--trinity-text-base)]',
} as const;

const textareaSize = {
  sm: 'min-h-14 px-2 py-1.5 text-sm',
  md: 'min-h-16 px-2.5 py-2 text-[length:var(--trinity-type-control-size)]',
  lg: 'min-h-20 px-3 py-2.5 text-base [--trinity-entry-font-size:var(--trinity-text-base)]',
} as const;

const base =
  'w-full min-w-0 rounded-[var(--trinity-shape-control-radius)] border border-[var(--trinity-border-control)] bg-transparent text-[var(--trinity-text-bright)] outline-none transition-[background-color,border-color,box-shadow] placeholder:text-[var(--trinity-text-muted)] focus-visible:border-[var(--trinity-focus-ring)] focus-visible:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-focus-ring)] data-[matches-spartan-invalid=true]:border-danger data-[matches-spartan-invalid=true]:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-danger)] disabled:cursor-not-allowed disabled:bg-[var(--trinity-surface-raised)] disabled:opacity-[var(--trinity-disabled-opacity)]';

/**
 * A field on an attention surface (an accent `trn-banner`, `trn-page-header` or
 * `trnOverlaySurface`, which mark themselves `data-trn-surface="attention"`) sits on the
 * accent, where the neutral value, placeholder and border colours fall near 1:1 (#1241). There
 * it switches to the attention control roles, and a disabled field stays transparent instead
 * of nesting a neutral fill. Its focus ring already follows the surface's on-attention ring.
 * An invalid field's border and ring take the attention danger role (#1244), which keeps 3:1
 * against the accent where the neutral danger falls near 1.4:1; the 2px ring is the cue that
 * does not rely on hue.
 */
const onAttention =
  'in-data-[trn-surface=attention]:border-[var(--trinity-state-attention-control-border)] in-data-[trn-surface=attention]:text-[var(--trinity-state-attention-control-foreground)] in-data-[trn-surface=attention]:placeholder:text-[var(--trinity-state-attention-control-placeholder)] in-data-[trn-surface=attention]:disabled:bg-transparent in-data-[trn-surface=attention]:data-[matches-spartan-invalid=true]:border-[var(--trinity-state-attention-control-danger)] in-data-[trn-surface=attention]:data-[matches-spartan-invalid=true]:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-state-attention-control-danger)]';

export function trnInputRecipe(
  size: TrnTextControlSize,
  invalid = false,
): string {
  return hlm(
    base,
    onAttention,
    'file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-[var(--trinity-text-bright)] in-data-[trn-surface=attention]:file:text-[var(--trinity-state-attention-control-foreground)]',
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
    onAttention,
    'flex field-sizing-content',
    textareaSize[size],
    invalid
      ? 'border-danger shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-danger)]'
      : '',
  );
}
