import type { TrnSize } from '@trinity/components/foundations';
import { hlm } from '@trinity/helm/utils';

export type TrnSelectSize = Extract<TrnSize, 'sm' | 'md'>;

/** Private adapter to Helm's size vocabulary; `default` never crosses Controls' entrypoint. */
export function trnSelectHelmSize(size: TrnSelectSize): 'sm' | 'default' {
  return size === 'sm' ? 'sm' : 'default';
}

/**
 * A trigger on an attention surface sits on the accent, where the neutral value, placeholder,
 * chevron and border colours fall near 1:1. There it takes the attention control roles and
 * drops Helm's translucent dark fill and hover, which would tint the accent ground. Helm keeps
 * `outline-none` and draws focus as a border and a half-transparent `--ring` halo, which falls
 * below 3:1 on the dark accents, so both take the surface's on-attention ring. An invalid
 * trigger's border and ring take the attention danger role instead of Helm's destructive
 * border and translucent halo, which fall near 1:1; the opaque ring is the cue that does not
 * rely on hue. Focused, the ring turns to the surface's focus ring and the danger border stays.
 */
const triggerOnAttention =
  'in-data-[trn-surface=attention]:border-[var(--trinity-state-attention-control-border)] in-data-[trn-surface=attention]:text-[var(--trinity-state-attention-control-foreground)] in-data-[trn-surface=attention]:data-placeholder:text-[var(--trinity-state-attention-control-placeholder)] in-data-[trn-surface=attention]:[&_ng-icon]:text-[var(--trinity-state-attention-control-foreground)] in-data-[trn-surface=attention]:dark:bg-transparent in-data-[trn-surface=attention]:dark:hover:bg-transparent in-data-[trn-surface=attention]:focus-visible:border-[var(--trinity-focus-ring)] in-data-[trn-surface=attention]:focus-visible:ring-[color:var(--trinity-focus-ring)] in-data-[trn-surface=attention]:data-[matches-spartan-invalid=true]:border-[var(--trinity-state-attention-control-danger)] in-data-[trn-surface=attention]:dark:data-[matches-spartan-invalid=true]:border-[var(--trinity-state-attention-control-danger)] in-data-[trn-surface=attention]:data-[matches-spartan-invalid=true]:ring-[color:var(--trinity-state-attention-control-danger)] in-data-[trn-surface=attention]:dark:data-[matches-spartan-invalid=true]:ring-[color:var(--trinity-state-attention-control-danger)] in-data-[trn-surface=attention]:data-[matches-spartan-invalid=true]:focus-visible:ring-[color:var(--trinity-focus-ring)]';

/** The focusable trigger fills the public select host without a caller class escape. */
export function trnSelectTriggerRecipe(): string {
  return hlm(
    'w-full border-[var(--trinity-border-control)]',
    triggerOnAttention,
  );
}
