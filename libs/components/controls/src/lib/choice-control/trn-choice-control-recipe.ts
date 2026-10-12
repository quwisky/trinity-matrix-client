import { hlm } from '@trinity/helm/utils';

/**
 * A choice control on an attention surface (an accent `trn-banner`, `trn-page-header` or
 * `trnOverlaySurface`, which mark themselves `data-trn-surface="attention"`) sits on the
 * accent, where its neutral border falls near 1:1 and its accent fill vanishes (#1244). There
 * the resting border and unchecked track take the attention control border, and the checked
 * fill inverts like a solid action: the attention action surface with the attention action
 * foreground for the check mark and thumb. The focus ring shares the checked fill's colour,
 * so it sits on a gap in the surface colour. An invalid box takes the attention danger role.
 */
const ringOnAttention =
  'in-data-[trn-surface=attention]:peer-focus-visible:shadow-[0_0_0_var(--trinity-focus-ring-offset)_var(--trinity-state-attention-surface),0_0_0_calc(var(--trinity-focus-ring-offset)+var(--trinity-focus-ring-width))_var(--trinity-focus-ring)]';

const checkboxOnAttention =
  'in-data-[trn-surface=attention]:border-[var(--trinity-state-attention-control-border)] in-data-[trn-surface=attention]:data-[invalid=true]:border-[var(--trinity-state-attention-control-danger)] in-data-[trn-surface=attention]:data-checked:border-[var(--trinity-state-attention-action-surface)] in-data-[trn-surface=attention]:data-checked:bg-[var(--trinity-state-attention-action-surface)] in-data-[trn-surface=attention]:data-checked:text-[var(--trinity-state-attention-action-foreground)]';

const switchOnAttention =
  'in-data-[trn-surface=attention]:bg-[var(--trinity-state-attention-control-border)] in-data-[trn-surface=attention]:data-[checked=true]:bg-[var(--trinity-state-attention-action-surface)]';

const thumbOnAttention =
  'in-data-[trn-surface=attention]:bg-[var(--trinity-state-attention-action-foreground)]';

export function trnCheckboxRecipe(): string {
  return hlm(
    'inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-[var(--trinity-border-control)] bg-transparent text-[10px] leading-none peer-focus-visible:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-focus-ring)] peer-disabled:cursor-default peer-disabled:opacity-[var(--trinity-disabled-opacity)] data-[invalid=true]:border-danger',
    'data-checked:border-[var(--trinity-accent)] data-checked:bg-[var(--trinity-accent)] data-checked:text-[var(--trinity-accent-foreground)]',
    checkboxOnAttention,
    ringOnAttention,
  );
}

export function trnSwitchRecipe(): string {
  return hlm(
    'relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full bg-[var(--trinity-border-control)] transition-colors peer-focus-visible:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-focus-ring)] peer-disabled:cursor-default peer-disabled:opacity-[var(--trinity-disabled-opacity)]',
    'data-[checked=true]:bg-[var(--trinity-accent)]',
    switchOnAttention,
    ringOnAttention,
  );
}

export function trnSwitchThumbRecipe(checked: boolean): string {
  return hlm(
    'pointer-events-none absolute left-px block size-4 rounded-full bg-[var(--trinity-surface-raised)] transition-transform',
    checked
      ? 'translate-x-[14px] bg-[var(--trinity-accent-foreground)]'
      : 'translate-x-0',
    thumbOnAttention,
  );
}
