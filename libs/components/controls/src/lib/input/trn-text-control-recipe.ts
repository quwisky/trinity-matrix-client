import type { TrnSize } from '@trinity/components/foundations';
import { hlm } from '@trinity/helm/utils';

export type TrnTextControlSize = Extract<TrnSize, 'sm' | 'md' | 'lg'>;

/**
 * Medium and large fields type at the composer's entry size, which the touch floor in
 * `global.scss` lifts to 16px so iOS does not zoom on focus. Small fields stay compact.
 */
const entryText =
  'text-[length:var(--trinity-text-base)] [--trinity-entry-font-size:var(--trinity-text-base)] leading-[1.4]';

const inputSize = {
  sm: 'min-h-[max(1.75rem,var(--trinity-interaction-target-min-size))] px-2 py-0.5 text-[length:var(--trinity-text-sm)] leading-[1.4]',
  md: `min-h-[max(var(--trinity-density-control-size),var(--trinity-interaction-target-min-size))] px-2.5 py-0.5 ${entryText}`,
  lg: `min-h-[max(2.5rem,var(--trinity-interaction-target-min-size))] px-3 py-2 ${entryText}`,
} as const;

const textareaSize = {
  sm: 'min-h-14 px-2 py-1.5 text-[length:var(--trinity-text-sm)] leading-[1.4]',
  md: `min-h-16 px-2.5 py-2 ${entryText}`,
  lg: `min-h-20 px-3 py-2.5 ${entryText}`,
} as const;

const invalid =
  'border-danger outline-solid outline-[length:var(--trinity-focus-ring-width)] outline-offset-[calc(-1*var(--trinity-focus-ring-width))] outline-[color:var(--trinity-danger)]';

/** WebKit paints disabled text with its own fill colour, so the text-fill override is needed. */
const base =
  'w-full min-w-0 rounded-[var(--trinity-entry-radius)] border border-[var(--trinity-entry-border)] bg-[var(--trinity-entry-surface)] text-[var(--trinity-text-bright)] outline-none transition-[background-color,border-color] placeholder:text-[var(--trinity-text-muted)] focus-visible:outline-solid focus-visible:outline-[length:var(--trinity-focus-ring-width)] focus-visible:outline-offset-[calc(-1*var(--trinity-focus-ring-width))] focus-visible:outline-[color:var(--trinity-focus-ring)] data-[matches-spartan-invalid=true]:border-danger data-[matches-spartan-invalid=true]:outline-solid data-[matches-spartan-invalid=true]:outline-[length:var(--trinity-focus-ring-width)] data-[matches-spartan-invalid=true]:outline-offset-[calc(-1*var(--trinity-focus-ring-width))] data-[matches-spartan-invalid=true]:outline-[color:var(--trinity-danger)] data-[matches-spartan-invalid=true]:focus-visible:outline-[color:var(--trinity-focus-ring)] [&[readonly]]:bg-transparent disabled:cursor-not-allowed disabled:border-dashed disabled:border-[var(--trinity-text-muted)] disabled:bg-transparent disabled:text-[var(--trinity-text-muted)] disabled:opacity-100 disabled:[-webkit-text-fill-color:var(--trinity-text-muted)]';

/**
 * A field on an attention surface (an accent `trn-banner`, `trn-page-header` or
 * `trnOverlaySurface`, which mark themselves `data-trn-surface="attention"`) sits on the
 * accent, where the neutral value, placeholder and border colours fall near 1:1. There it
 * switches to the attention control roles and stays transparent instead of nesting the neutral
 * entry fill. Its focus ring already follows the surface's on-attention ring. A disabled field
 * draws its dashed edge in the attention border and its value in the attention placeholder
 * colour. An invalid field's border and ring take the attention danger role, which keeps 3:1
 * against the accent where the neutral danger falls near 1.4:1; the 2px ring is the cue that
 * does not rely on hue. Focused, the ring turns to the surface's focus ring and the danger
 * border stays.
 */
const onAttention =
  'in-data-[trn-surface=attention]:border-[var(--trinity-state-attention-control-border)] in-data-[trn-surface=attention]:bg-transparent in-data-[trn-surface=attention]:text-[var(--trinity-state-attention-control-foreground)] in-data-[trn-surface=attention]:placeholder:text-[var(--trinity-state-attention-control-placeholder)] in-data-[trn-surface=attention]:disabled:border-[var(--trinity-state-attention-control-border)] in-data-[trn-surface=attention]:disabled:text-[var(--trinity-state-attention-control-placeholder)] in-data-[trn-surface=attention]:disabled:[-webkit-text-fill-color:var(--trinity-state-attention-control-placeholder)] in-data-[trn-surface=attention]:data-[matches-spartan-invalid=true]:border-[var(--trinity-state-attention-control-danger)] in-data-[trn-surface=attention]:data-[matches-spartan-invalid=true]:outline-[color:var(--trinity-state-attention-control-danger)] in-data-[trn-surface=attention]:data-[matches-spartan-invalid=true]:focus-visible:outline-[color:var(--trinity-focus-ring)]';

export function trnInputRecipe(
  size: TrnTextControlSize,
  explicitInvalid = false,
): string {
  return hlm(
    base,
    onAttention,
    'file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-[var(--trinity-text-bright)] in-data-[trn-surface=attention]:file:text-[var(--trinity-state-attention-control-foreground)]',
    inputSize[size],
    explicitInvalid ? invalid : '',
  );
}

export function trnTextareaRecipe(
  size: TrnTextControlSize,
  explicitInvalid = false,
): string {
  return hlm(
    base,
    onAttention,
    'flex field-sizing-content',
    textareaSize[size],
    explicitInvalid ? invalid : '',
  );
}
