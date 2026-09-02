import type { TrnVariant } from '@trinity/components/foundations';
import { hlm } from '@trinity/helm/utils';

export type TrnPageHeaderVariant = Extract<TrnVariant, 'neutral' | 'accent'>;
export type TrnPageHeaderLayout = 'page' | 'toolbar';

type LegacyPageHeaderVariant = 'page' | 'chat';

export type TrnPageHeaderVariantInput =
  TrnPageHeaderVariant | LegacyPageHeaderVariant;

const variantRecipe = {
  neutral:
    'bg-[var(--trinity-surface-workspace)] text-[var(--trinity-text-bright)]',
  accent:
    'bg-[var(--trinity-state-attention-surface)] text-[var(--trinity-state-attention-foreground)]',
} as const;

const layoutRecipe = {
  page: 'safe-top min-h-14 gap-2 px-3',
  toolbar: 'h-14 gap-1 px-2',
} as const;

const titleLayoutRecipe = {
  page: 'flex-1 truncate text-base font-semibold',
  toolbar:
    'flex min-w-0 flex-1 items-center gap-1 px-1 text-base font-semibold',
} as const;

export function normalizeTrnPageHeaderVariant(
  variant: TrnPageHeaderVariantInput,
): TrnPageHeaderVariant {
  return variant === 'accent' ? 'accent' : 'neutral';
}

export function normalizeTrnPageHeaderLayout(
  variant: TrnPageHeaderVariantInput,
  layout: TrnPageHeaderLayout,
): TrnPageHeaderLayout {
  switch (variant) {
    case 'page':
      return 'page';
    case 'chat':
      return 'toolbar';
    default:
      return layout;
  }
}

export function trnPageHeaderRecipe(
  variant: TrnPageHeaderVariant,
  layout: TrnPageHeaderLayout,
): string {
  return hlm(
    'flex shrink-0 items-center border-b border-solid border-[var(--trinity-border-subtle)]',
    variantRecipe[variant],
    layoutRecipe[layout],
  );
}

export function trnPageHeaderTitleRecipe(layout: TrnPageHeaderLayout): string {
  return titleLayoutRecipe[layout];
}
