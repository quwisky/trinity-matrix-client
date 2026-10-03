import { hlm } from '@trinity/helm/utils';

export type TrnRadioGroupLayout = 'list' | 'segmented';

const selectedTone =
  'data-[state=selected]:bg-[var(--trinity-state-selected-surface)] data-[state=selected]:text-[var(--trinity-state-selected-foreground)]';

export function trnRadioGroupRecipe(layout: TrnRadioGroupLayout): string {
  if (layout === 'segmented') {
    return 'grid grid-flow-col auto-cols-fr gap-1 rounded-[var(--trinity-shape-control-radius)] border border-[var(--trinity-border-control)] bg-[var(--trinity-surface-floating)] p-1';
  }

  return 'grid gap-2';
}

export function trnRadioOptionRecipe(layout: TrnRadioGroupLayout): string {
  return hlm(
    'group flex cursor-pointer items-center font-medium text-[var(--trinity-text-muted)] transition-[background-color,color,box-shadow] has-[:focus-visible]:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-focus-ring)] data-[disabled=true]:cursor-default data-[disabled=true]:opacity-[var(--trinity-disabled-opacity)]',
    'min-h-[max(2rem,var(--trinity-interaction-target-min-size))] text-sm',
    layout === 'segmented'
      ? 'justify-center rounded-[calc(var(--trinity-shape-control-radius)-2px)] px-3 text-center [overflow-wrap:anywhere] hover:bg-[var(--trinity-state-hover-surface)] hover:text-[var(--trinity-state-hover-foreground)]'
      : 'gap-3',
    layout === 'segmented' ? selectedTone : '',
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
  );
}

export function trnRadioIndicatorDotRecipe(selected: boolean): string {
  return hlm(
    'size-2 rounded-full',
    selected
      ? 'bg-[var(--trinity-state-selected-foreground)]'
      : 'bg-transparent',
  );
}
