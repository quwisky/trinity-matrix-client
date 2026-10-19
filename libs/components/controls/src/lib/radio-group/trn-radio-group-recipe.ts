import { hlm } from '@trinity/helm/utils';

/** `boxed` is a list inside a bordered box, each option's description at the end of its line. */
export type TrnRadioGroupLayout = 'list' | 'segmented' | 'boxed';

const selectedTone =
  'data-[state=selected]:bg-[var(--trinity-state-selected-surface)] data-[state=selected]:text-[var(--trinity-state-selected-foreground)]';

/**
 * A segmented group on an attention surface. The neutral track would nest a light
 * floating fill in the accent, where the on-attention ring and the selected option both fail
 * against it. There the track keeps the surface colour with the attention control border,
 * the options take the attention foreground, and the selected option inverts like a solid
 * action. The ring sits on a gap in the track colour so it stays distinct from the selected
 * fill it shares a colour with; the track's padding leaves room for both.
 */
const segmentedTrackOnAttention =
  'in-data-[trn-surface=attention]:border-[var(--trinity-state-attention-control-border)] in-data-[trn-surface=attention]:bg-[var(--trinity-state-attention-control-track-surface)]';

const segmentedOptionOnAttention =
  'in-data-[trn-surface=attention]:text-[var(--trinity-state-attention-control-foreground)] in-data-[trn-surface=attention]:hover:bg-[var(--trinity-state-attention-action-hover-surface)] in-data-[trn-surface=attention]:hover:text-[var(--trinity-state-attention-action-foreground)] in-data-[trn-surface=attention]:data-[state=selected]:bg-[var(--trinity-state-attention-action-surface)] in-data-[trn-surface=attention]:data-[state=selected]:text-[var(--trinity-state-attention-action-foreground)] in-data-[trn-surface=attention]:has-[:focus-visible]:shadow-[0_0_0_var(--trinity-focus-ring-offset)_var(--trinity-state-attention-control-track-surface),0_0_0_calc(var(--trinity-focus-ring-offset)+var(--trinity-focus-ring-width))_var(--trinity-focus-ring)]';

/**
 * A list option on an attention surface. Its label takes the attention foreground,
 * the indicator ring the attention control border, and the checked dot the attention
 * foreground. In an invalid group the indicator takes the attention danger border and the
 * same opaque 2px danger ring as an invalid field, the cue that does not rely on hue. The
 * focused indicator's border and ring keep the on-attention ring the surface sets, because
 * the neutral `peer-focus-visible:` classes already out-rank these.
 */
const listOptionOnAttention =
  'in-data-[trn-surface=attention]:text-[var(--trinity-state-attention-control-foreground)]';

const indicatorBorderOnAttention = {
  valid:
    'in-data-[trn-surface=attention]:border-[var(--trinity-state-attention-control-border)]',
  invalid:
    'in-data-[trn-surface=attention]:border-[var(--trinity-state-attention-control-danger)] in-data-[trn-surface=attention]:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-state-attention-control-danger)]',
} as const;

const dotOnAttention =
  'in-data-[trn-surface=attention]:bg-[var(--trinity-state-attention-control-foreground)]';

/**
 * An option description is quieter than its label on a neutral surface. On an attention
 * surface it follows its option's foreground instead, so it stays readable on the track, the
 * hover fill and the inverted selected fill, where the muted neutral text falls below 4.5:1.
 */
export function trnRadioDescriptionRecipe(): string {
  return 'text-xs leading-snug font-normal text-[var(--trinity-text-muted)] in-data-[trn-surface=attention]:text-current';
}

export function trnRadioGroupRecipe(layout: TrnRadioGroupLayout): string {
  if (layout === 'segmented') {
    return hlm(
      'grid auto-cols-fr grid-flow-col gap-1 rounded-[var(--trinity-shape-control-radius)] border border-[var(--trinity-border-control)] bg-[var(--trinity-surface-floating)] p-1',
      segmentedTrackOnAttention,
    );
  }

  if (layout === 'boxed') {
    return 'grid rounded-[var(--trinity-shape-control-radius)] border border-[var(--trinity-border-overlay)] px-3 py-1';
  }

  return 'grid gap-2';
}

/** The label and description: stacked, or on one line with the description at the end. */
export function trnRadioTextRecipe(layout: TrnRadioGroupLayout): string {
  return layout === 'boxed'
    ? 'flex min-w-0 flex-1 items-baseline justify-between gap-3 [&>small]:text-end'
    : 'flex min-w-0 flex-col items-start gap-0.5';
}

/**
 * Dims a disabled option's indicator and label but not its description, which may explain
 * why the option is unavailable and must stay readable.
 */
export const trnRadioDisabledDim =
  'group-data-[disabled=true]:opacity-[var(--trinity-disabled-opacity)]';

export function trnRadioOptionRecipe(layout: TrnRadioGroupLayout): string {
  return hlm(
    'group flex cursor-pointer items-center font-medium text-[var(--trinity-text-muted)] transition-[background-color,color,box-shadow] has-[:focus-visible]:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-focus-ring)] data-[disabled=true]:cursor-default',
    'min-h-[max(2rem,var(--trinity-interaction-target-min-size))] text-sm',
    layout === 'segmented'
      ? 'justify-center rounded-[calc(var(--trinity-shape-control-radius)-2px)] px-3 text-center [overflow-wrap:anywhere] hover:bg-[var(--trinity-state-hover-surface)] hover:text-[var(--trinity-state-hover-foreground)]'
      : 'gap-3',
    layout === 'segmented' ? selectedTone : '',
    layout === 'segmented' ? segmentedOptionOnAttention : listOptionOnAttention,
  );
}

export function trnRadioIndicatorRecipe(
  layout: TrnRadioGroupLayout,
  invalid: boolean,
): string {
  return hlm(
    'flex shrink-0 items-center justify-center rounded-full border bg-transparent transition-[border-color,box-shadow] peer-focus-visible:border-[var(--trinity-focus-ring)] peer-focus-visible:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-focus-ring)]',
    layout === 'segmented' ? 'hidden' : '',
    'size-4',
    invalid ? 'border-danger' : 'border-[var(--trinity-border-control)]',
    invalid
      ? indicatorBorderOnAttention.invalid
      : indicatorBorderOnAttention.valid,
  );
}

export function trnRadioIndicatorDotRecipe(selected: boolean): string {
  return hlm(
    'size-2 rounded-full',
    selected
      ? 'bg-[var(--trinity-state-selected-foreground)]'
      : 'bg-transparent',
    selected ? dotOnAttention : '',
  );
}
