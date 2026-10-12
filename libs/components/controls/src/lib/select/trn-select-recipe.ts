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

/**
 * A trigger on an attention surface (#1241) sits on the accent, where the neutral value,
 * placeholder, chevron and border colours fall near 1:1. There it takes the attention control
 * roles, and drops Helm's translucent dark fill and hover, which would tint the accent ground.
 * Its focus outline already follows the surface's on-attention ring.
 */
const triggerOnAttention =
  'in-data-[trn-surface=attention]:border-[var(--trinity-state-attention-control-border)] in-data-[trn-surface=attention]:text-[var(--trinity-state-attention-control-foreground)] in-data-[trn-surface=attention]:data-placeholder:text-[var(--trinity-state-attention-control-placeholder)] in-data-[trn-surface=attention]:[&_ng-icon]:text-[var(--trinity-state-attention-control-foreground)] in-data-[trn-surface=attention]:dark:bg-transparent in-data-[trn-surface=attention]:dark:hover:bg-transparent';

/** The focusable trigger fills the public select host without a caller class escape. */
export function trnSelectTriggerRecipe(): string {
  return `w-full border-[var(--trinity-border-control)] ${triggerOnAttention}`;
}
