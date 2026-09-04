import type { TrnVariant } from '@trinity/components/foundations';
import { hlm } from '@trinity/helm/utils';

export type TrnDropdownMenuItemVariant = Extract<
  TrnVariant,
  'neutral' | 'danger'
>;
/** The vendor row supplies structure and behavior; Trinity owns semantic danger ink. */
export function trnDropdownMenuItemRecipe(
  variant: TrnDropdownMenuItemVariant,
): string {
  return hlm(
    variant === 'danger' &&
      'text-danger hover:bg-[var(--trinity-danger-tint-10)] hover:text-danger focus:bg-[var(--trinity-danger-tint-10)] focus:text-danger dark:hover:bg-[var(--trinity-danger-tint-20)] dark:focus:bg-[var(--trinity-danger-tint-20)] *:[trn-icon]:text-danger',
  );
}
