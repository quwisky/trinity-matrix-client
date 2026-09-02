import type { TrnVariant } from '@trinity/components/foundations';
import { hlm } from '@trinity/helm/utils';

export type TrnTabsVariant = Extract<TrnVariant, 'neutral' | 'accent'>;
export type TrnTabsPresentation = 'pill' | 'line';

/** Keep enabled tab labels on Trinity text roles instead of vendor opacity. */
export function trnTabsTriggerRecipe(variant: TrnTabsVariant): string {
  return hlm(
    'text-[var(--trinity-text-muted)] hover:text-[var(--trinity-text-bright)] dark:text-[var(--trinity-text-muted)] dark:hover:text-[var(--trinity-text-bright)] data-active:text-[var(--trinity-text-bright)] dark:data-active:text-[var(--trinity-text-bright)]',
    variant === 'accent' &&
      'data-active:bg-[var(--trinity-state-attention-surface)]! data-active:text-[var(--trinity-state-attention-foreground)]! group-data-[variant=line]/tabs-list:data-active:bg-transparent! group-data-[variant=line]/tabs-list:data-active:text-link! group-data-[variant=line]/tabs-list:data-active:after:bg-[var(--trinity-state-attention-surface)]',
  );
}
