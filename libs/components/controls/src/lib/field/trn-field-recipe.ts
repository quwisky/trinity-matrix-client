import { hlm } from '@trinity/helm/utils';

/** Typographic prominence for a field label; validation is a separate state. */
export type TrnFieldLabelEmphasis = 'normal' | 'strong';

/** Temporary pre-recipe vocabulary retained until the consumer migration closes. */
export type TrnFieldLabelVariant = 'default' | 'eyebrow';

export function resolveTrnFieldLabelEmphasis(
  emphasis: TrnFieldLabelEmphasis | null,
  variant: TrnFieldLabelVariant,
): TrnFieldLabelEmphasis {
  return emphasis ?? (variant === 'eyebrow' ? 'strong' : 'normal');
}

export function trnFieldLabelRecipe(
  emphasis: TrnFieldLabelEmphasis,
  invalid: boolean,
): string {
  return hlm(
    'text-[var(--trinity-text-bright)]',
    emphasis === 'strong'
      ? 'text-[length:var(--trinity-type-caption-size)] font-bold tracking-[0.04em] text-[var(--trinity-text-muted)] uppercase'
      : '',
    invalid ? 'text-danger' : '',
  );
}
