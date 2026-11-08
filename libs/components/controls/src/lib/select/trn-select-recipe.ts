import type { TrnSize } from '@trinity/components/foundations';
import { hlm } from '@trinity/helm/utils';

export type TrnSelectSize = Extract<TrnSize, 'sm' | 'md'>;

/** Private adapter to Helm's size vocabulary; `default` never crosses Controls' entrypoint. */
export function trnSelectHelmSize(size: TrnSelectSize): 'sm' | 'default' {
  return size === 'sm' ? 'sm' : 'default';
}

/**
 * The trigger sits beside text fields, so it takes their look (see `trnInputRecipe`): the
 * entry fill, radius and border, the field's type size, and the composer's inset focus ring in
 * place of Helm's border colour and half-transparent `--ring` halo. Invalid, it keeps a danger
 * border and draws that ring in danger until focused. Disabled, it drops the fill for a dashed
 * muted edge and muted text at full opacity, and hides the chevron of a list that cannot open; inside a
 * `trn-field-lock` it reserves the end padding for the lock.
 */
const entryLook =
  'w-full rounded-[var(--trinity-entry-radius)] data-[size=sm]:rounded-[var(--trinity-entry-radius)] border-[var(--trinity-entry-border)] bg-[var(--trinity-entry-surface)] dark:bg-[var(--trinity-entry-surface)] dark:hover:bg-[var(--trinity-entry-surface)] text-[length:var(--trinity-text-base)] data-[size=sm]:text-[length:var(--trinity-text-sm)] focus-visible:border-[var(--trinity-entry-border)] focus-visible:ring-0 focus-visible:outline-solid focus-visible:outline-[length:var(--trinity-focus-ring-width)] focus-visible:outline-offset-[calc(-1*var(--trinity-focus-ring-width))] focus-visible:outline-[color:var(--trinity-focus-ring)] data-[matches-spartan-invalid=true]:ring-0 data-[matches-spartan-invalid=true]:border-danger dark:data-[matches-spartan-invalid=true]:border-danger data-[matches-spartan-invalid=true]:outline-solid data-[matches-spartan-invalid=true]:outline-[length:var(--trinity-focus-ring-width)] data-[matches-spartan-invalid=true]:outline-offset-[calc(-1*var(--trinity-focus-ring-width))] data-[matches-spartan-invalid=true]:outline-[color:var(--trinity-danger)] data-[matches-spartan-invalid=true]:focus-visible:outline-[color:var(--trinity-focus-ring)] disabled:cursor-not-allowed disabled:opacity-100 disabled:border-dashed disabled:border-[var(--trinity-text-muted)] disabled:bg-transparent dark:disabled:bg-transparent disabled:text-[var(--trinity-text-muted)] disabled:[&_ng-icon]:invisible in-data-[locked]:disabled:pe-12';

/**
 * A trigger on an attention surface sits on the accent, where the neutral value, placeholder,
 * chevron and border colours fall near 1:1. There it takes the attention control roles and
 * stays transparent instead of nesting the entry fill. Its focus ring already follows the
 * surface's on-attention ring. A disabled trigger draws its dashed edge in the attention border
 * and its value in the attention placeholder colour. An invalid trigger's border and ring take
 * the attention danger role, which keeps 3:1 against the accent; the opaque ring is the cue
 * that does not rely on hue. Focused, the ring turns to the surface's focus ring and the danger
 * border stays.
 */
const triggerOnAttention =
  'in-data-[trn-surface=attention]:border-[var(--trinity-state-attention-control-border)] in-data-[trn-surface=attention]:bg-transparent in-data-[trn-surface=attention]:text-[var(--trinity-state-attention-control-foreground)] in-data-[trn-surface=attention]:data-placeholder:text-[var(--trinity-state-attention-control-placeholder)] in-data-[trn-surface=attention]:[&_ng-icon]:text-[var(--trinity-state-attention-control-foreground)] in-data-[trn-surface=attention]:dark:bg-transparent in-data-[trn-surface=attention]:dark:hover:bg-transparent in-data-[trn-surface=attention]:focus-visible:border-[var(--trinity-state-attention-control-border)] in-data-[trn-surface=attention]:disabled:border-[var(--trinity-state-attention-control-border)] in-data-[trn-surface=attention]:disabled:text-[var(--trinity-state-attention-control-placeholder)] in-data-[trn-surface=attention]:dark:disabled:bg-transparent in-data-[trn-surface=attention]:data-[matches-spartan-invalid=true]:border-[var(--trinity-state-attention-control-danger)] in-data-[trn-surface=attention]:dark:data-[matches-spartan-invalid=true]:border-[var(--trinity-state-attention-control-danger)] in-data-[trn-surface=attention]:data-[matches-spartan-invalid=true]:outline-[color:var(--trinity-state-attention-control-danger)] in-data-[trn-surface=attention]:data-[matches-spartan-invalid=true]:focus-visible:outline-[color:var(--trinity-focus-ring)]';

/** The focusable trigger fills the public select host without a caller class escape. */
export function trnSelectTriggerRecipe(): string {
  return hlm(entryLook, triggerOnAttention);
}
