import type { TrnSize, TrnVariant } from '@trinity/components/foundations';
import { hlm } from '@trinity/helm/utils';

export type TrnToggleVariant = Extract<TrnVariant, 'neutral' | 'accent'>;
export type TrnToggleSize = Extract<TrnSize, 'sm' | 'md' | 'lg'>;
export type TrnTogglePresentation = 'plain' | 'outline';
export type TrnToggleArrangement = 'joined' | 'separated';

type LegacyToggleVariant = 'default' | 'outline';
type LegacyToggleSize = 'default';

export type TrnToggleVariantInput = TrnToggleVariant | LegacyToggleVariant;
export type TrnToggleSizeInput = TrnToggleSize | LegacyToggleSize;

interface TrnToggleRecipeOptions {
  arrangement?: TrnToggleArrangement;
  presentation: TrnTogglePresentation;
  size: TrnToggleSize;
  variant: TrnToggleVariant;
}

const sizeRecipe = {
  sm: 'h-7 min-w-7 px-2 text-[0.8rem]',
  md: 'h-8 min-w-8 px-2.5 text-sm',
  lg: 'h-9 min-w-9 px-3 text-sm',
} as const;

const selectedTone = {
  neutral:
    'aria-pressed:bg-[var(--trinity-state-selected-surface)] aria-pressed:text-[var(--trinity-state-selected-foreground)] data-[state=on]:bg-[var(--trinity-state-selected-surface)] data-[state=on]:text-[var(--trinity-state-selected-foreground)]',
  accent:
    'aria-pressed:bg-[var(--trinity-accent)] aria-pressed:text-[var(--trinity-accent-foreground)] data-[state=on]:bg-[var(--trinity-accent)] data-[state=on]:text-[var(--trinity-accent-foreground)]',
} as const;

const presentationRecipe = {
  plain: 'border border-transparent bg-transparent',
  outline:
    'border border-[var(--trinity-border-strong)] bg-transparent hover:border-[var(--trinity-accent)]',
} as const;

const joinedRecipe =
  'rounded-none first:rounded-s-[var(--trinity-shape-control-radius)] last:rounded-e-[var(--trinity-shape-control-radius)] group-data-[trn-orientation=vertical]/trn-toggle-group:first:rounded-s-none group-data-[trn-orientation=vertical]/trn-toggle-group:last:rounded-e-none group-data-[trn-orientation=vertical]/trn-toggle-group:first:rounded-t-[var(--trinity-shape-control-radius)] group-data-[trn-orientation=vertical]/trn-toggle-group:last:rounded-b-[var(--trinity-shape-control-radius)] group-data-[trn-presentation=outline]/trn-toggle-group:[&:not(:first-child)]:border-s-0 group-data-[trn-orientation=vertical]/trn-toggle-group:group-data-[trn-presentation=outline]/trn-toggle-group:[&:not(:first-child)]:border-s group-data-[trn-orientation=vertical]/trn-toggle-group:group-data-[trn-presentation=outline]/trn-toggle-group:[&:not(:first-child)]:border-t-0';

export function normalizeTrnToggleVariant(
  variant: TrnToggleVariantInput,
): TrnToggleVariant {
  return variant === 'accent' ? 'accent' : 'neutral';
}

export function normalizeTrnTogglePresentation(
  variant: TrnToggleVariantInput,
  presentation: TrnTogglePresentation,
): TrnTogglePresentation {
  return variant === 'outline' ? 'outline' : presentation;
}

export function normalizeTrnToggleSize(
  size: TrnToggleSizeInput,
): TrnToggleSize {
  return size === 'default' ? 'md' : size;
}

export function trnToggleRecipe(options: TrnToggleRecipeOptions): string {
  return hlm(
    'inline-flex shrink-0 items-center justify-center gap-1 rounded-[var(--trinity-shape-control-radius)] font-medium whitespace-nowrap text-[var(--trinity-text-muted)] transition-[background-color,color,border-color,box-shadow] outline-none hover:bg-[var(--trinity-state-hover-surface)] hover:text-[var(--trinity-state-hover-foreground)] focus-visible:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-focus-ring)] active:bg-[var(--trinity-state-pressed-surface)] disabled:pointer-events-none aria-disabled:cursor-default',
    sizeRecipe[options.size],
    presentationRecipe[options.presentation],
    selectedTone[options.variant],
    options.arrangement === 'joined' ? joinedRecipe : '',
  );
}

export function trnToggleGroupRecipe(
  arrangement: TrnToggleArrangement,
  orientation: 'horizontal' | 'vertical',
): string {
  return hlm(
    'group/trn-toggle-group flex w-fit items-center',
    orientation === 'vertical' ? 'flex-col items-stretch' : 'flex-row',
    arrangement === 'separated'
      ? 'gap-[var(--trinity-density-item-gap)]'
      : 'gap-0',
  );
}
