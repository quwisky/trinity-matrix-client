import type { TrnVariant } from '@trinity/components/foundations';

export type TrnTabsVariant = Extract<TrnVariant, 'neutral' | 'accent'>;
export type TrnTabsPresentation = 'pill' | 'line';

type LegacyTabsVariant = 'default' | 'line';

export type TrnTabsVariantInput = TrnTabsVariant | LegacyTabsVariant;

export function normalizeTrnTabsVariant(
  variant: TrnTabsVariantInput,
): TrnTabsVariant {
  return variant === 'accent' ? 'accent' : 'neutral';
}

export function normalizeTrnTabsPresentation(
  variant: TrnTabsVariantInput,
  presentation: TrnTabsPresentation,
): TrnTabsPresentation {
  switch (variant) {
    case 'default':
      return 'pill';
    case 'line':
      return 'line';
    default:
      return presentation;
  }
}
