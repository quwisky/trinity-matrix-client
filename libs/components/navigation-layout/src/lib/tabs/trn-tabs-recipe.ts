import type { TrnVariant } from '@trinity/components/foundations';

export type TrnTabsVariant = Extract<TrnVariant, 'neutral' | 'accent'>;
export type TrnTabsPresentation = 'pill' | 'line';
