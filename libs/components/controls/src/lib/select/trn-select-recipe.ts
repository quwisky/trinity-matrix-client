import type { TrnSize } from '@trinity/components/foundations';

export type TrnSelectSize = Extract<TrnSize, 'sm' | 'md'>;

/**
 * The select's private adapter to Helm's current size vocabulary.
 *
 * `default` is a vendor implementation detail and never crosses Controls' entrypoint.
 */
export function trnSelectHelmSize(size: TrnSelectSize): 'sm' | 'default' {
  return size === 'sm' ? 'sm' : 'default';
}

/** The focusable trigger fills the public select host without a caller class escape. */
export function trnSelectTriggerRecipe(): string {
  return 'w-full';
}
