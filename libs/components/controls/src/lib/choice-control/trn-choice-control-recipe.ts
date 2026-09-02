import type { TrnSize, TrnVariant } from '@trinity/components/foundations';
import { hlm } from '@trinity/helm/utils';

/** Semantic treatments shared by binary and exclusive choice controls. */
export type TrnChoiceVariant = Extract<TrnVariant, 'neutral' | 'accent'>;
export type TrnChoiceSize = Extract<TrnSize, 'sm' | 'md'>;

const controlSize = {
  sm: 'size-3.5',
  md: 'size-4',
} as const;

const checkedTone = {
  neutral:
    'data-checked:border-[var(--trinity-state-selected-foreground)] data-checked:bg-[var(--trinity-state-selected-surface)] data-checked:text-[var(--trinity-state-selected-foreground)]',
  accent:
    'data-checked:border-[var(--trinity-accent)] data-checked:bg-[var(--trinity-accent)] data-checked:text-[var(--trinity-accent-foreground)]',
} as const;

const switchTone = {
  neutral: 'data-[checked=true]:bg-[var(--trinity-state-selected-surface)]',
  accent: 'data-[checked=true]:bg-[var(--trinity-accent)]',
} as const;

export function trnCheckboxRecipe(
  variant: TrnChoiceVariant,
  size: TrnChoiceSize,
): string {
  return hlm(
    'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm border border-[var(--trinity-border-control)] bg-transparent text-[10px] leading-none peer-focus-visible:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-focus-ring)] peer-disabled:cursor-default peer-disabled:opacity-[var(--trinity-disabled-opacity)] data-[invalid=true]:border-danger',
    controlSize[size],
    checkedTone[variant],
  );
}

export function trnSwitchRecipe(
  variant: TrnChoiceVariant,
  size: TrnChoiceSize,
): string {
  return hlm(
    'relative inline-flex shrink-0 cursor-pointer items-center rounded-full bg-[var(--trinity-border-control)] transition-colors peer-focus-visible:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-focus-ring)] peer-disabled:cursor-default peer-disabled:opacity-[var(--trinity-disabled-opacity)]',
    size === 'sm' ? 'h-3.5 w-6' : 'h-[18px] w-8',
    switchTone[variant],
  );
}

export function trnSwitchThumbRecipe(
  checked: boolean,
  size: TrnChoiceSize,
  variant: TrnChoiceVariant,
): string {
  return hlm(
    'pointer-events-none absolute left-px block rounded-full bg-[var(--trinity-surface-raised)] transition-transform',
    size === 'sm' ? 'size-3' : 'size-4',
    checked
      ? size === 'sm'
        ? 'translate-x-[10px]'
        : 'translate-x-[14px]'
      : 'translate-x-0',
    checked && variant === 'accent'
      ? 'bg-[var(--trinity-accent-foreground)]'
      : '',
    checked && variant === 'neutral'
      ? 'bg-[var(--trinity-state-selected-foreground)]'
      : '',
  );
}
