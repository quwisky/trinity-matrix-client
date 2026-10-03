import { hlm } from '@trinity/helm/utils';

export function trnCheckboxRecipe(): string {
  return hlm(
    'inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-[var(--trinity-border-control)] bg-transparent text-[10px] leading-none peer-focus-visible:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-focus-ring)] peer-disabled:cursor-default peer-disabled:opacity-[var(--trinity-disabled-opacity)] data-[invalid=true]:border-danger',
    'data-checked:border-[var(--trinity-accent)] data-checked:bg-[var(--trinity-accent)] data-checked:text-[var(--trinity-accent-foreground)]',
  );
}

export function trnSwitchRecipe(): string {
  return hlm(
    'relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full bg-[var(--trinity-border-control)] transition-colors peer-focus-visible:shadow-[0_0_0_var(--trinity-focus-ring-width)_var(--trinity-focus-ring)] peer-disabled:cursor-default peer-disabled:opacity-[var(--trinity-disabled-opacity)]',
    'data-[checked=true]:bg-[var(--trinity-accent)]',
  );
}

export function trnSwitchThumbRecipe(checked: boolean): string {
  return hlm(
    'pointer-events-none absolute left-px block size-4 rounded-full bg-[var(--trinity-surface-raised)] transition-transform',
    checked
      ? 'translate-x-[14px] bg-[var(--trinity-accent-foreground)]'
      : 'translate-x-0',
  );
}
