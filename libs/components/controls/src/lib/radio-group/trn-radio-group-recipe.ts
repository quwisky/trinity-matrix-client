import { hlm } from '@trinity/helm/utils';
import type {
  TrnChoiceSize,
  TrnChoiceVariant,
} from '../choice-control/trn-choice-control-recipe';

export type TrnRadioGroupLayout = 'list' | 'segmented';

const listGap = {
  sm: 'gap-1.5',
  md: 'gap-2',
} as const;

const optionSize = {
  sm: 'min-h-[max(1.75rem,var(--trinity-interaction-target-min-size))] text-[0.8rem]',
  md: 'min-h-[max(2rem,var(--trinity-interaction-target-min-size))] text-sm',
} as const;

const selectedTone = {
  neutral:
    'data-[state=selected]:bg-[var(--trinity-state-selected-surface)] data-[state=selected]:text-[var(--trinity-state-selected-foreground)]',
  accent:
    'data-[state=selected]:bg-[var(--trinity-accent)] data-[state=selected]:text-[var(--trinity-accent-foreground)]',
} as const;

export function trnRadioGroupRecipe(
  layout: TrnRadioGroupLayout,
  size: TrnChoiceSize,
): string {
  if (layout === 'segmented') {
    return 'grid grid-flow-col auto-cols-fr gap-1 rounded-[var(--trinity-shape-control-radius)] border border-[var(--trinity-border-control)] bg-[var(--trinity-surface-floating)] p-1';
  }

  return hlm('grid', listGap[size]);
}

export function trnRadioOptionRecipe(
  layout: TrnRadioGroupLayout,
  size: TrnChoiceSize,
  variant: TrnChoiceVariant,
): string {
  return hlm(
    'group flex cursor-pointer items-center font-medium text-[var(--trinity-text-muted)] transition-[background-color,color,box-shadow] has-[:focus-visible]:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-focus-ring)] data-[disabled=true]:cursor-default data-[disabled=true]:opacity-[var(--trinity-disabled-opacity)]',
    optionSize[size],
    layout === 'segmented'
      ? 'justify-center rounded-[calc(var(--trinity-shape-control-radius)-2px)] px-3 text-center [overflow-wrap:anywhere] hover:bg-[var(--trinity-state-hover-surface)] hover:text-[var(--trinity-state-hover-foreground)]'
      : 'gap-3',
    layout === 'segmented' ? selectedTone[variant] : '',
  );
}

export function trnRadioIndicatorRecipe(
  layout: TrnRadioGroupLayout,
  size: TrnChoiceSize,
  invalid: boolean,
): string {
  return hlm(
    'flex shrink-0 items-center justify-center rounded-full border bg-transparent transition-[border-color,box-shadow] peer-focus-visible:border-[var(--trinity-focus-ring)] peer-focus-visible:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-focus-ring)]',
    layout === 'segmented' ? 'hidden' : '',
    size === 'sm' ? 'size-3.5' : 'size-4',
    invalid ? 'border-danger' : 'border-[var(--trinity-border-control)]',
  );
}

export function trnRadioIndicatorDotRecipe(
  selected: boolean,
  size: TrnChoiceSize,
  variant: TrnChoiceVariant,
): string {
  return hlm(
    'rounded-full',
    size === 'sm' ? 'size-1.5' : 'size-2',
    selected
      ? variant === 'accent'
        ? 'bg-[var(--trinity-accent)]'
        : 'bg-[var(--trinity-state-selected-foreground)]'
      : 'bg-transparent',
  );
}
