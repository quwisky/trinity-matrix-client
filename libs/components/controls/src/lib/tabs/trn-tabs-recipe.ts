import { hlm } from '@trinity/helm/utils';

/** Plain tabs on the surface: the row has no track, and each tab takes an equal share. */
export function trnTabListRecipe(): string {
  return hlm('flex gap-1');
}

/**
 * Only the selected tab is marked, with the selected-surface pill. A coarse pointer gets the
 * 44px touch target. Focus uses the global keyboard ring.
 */
export function trnTabRecipe(): string {
  return hlm(
    'inline-flex min-h-9 flex-1 items-center justify-center rounded-[var(--trinity-shape-control-radius)] px-3 text-sm font-semibold text-[var(--trinity-text-muted)] hover:bg-[var(--trinity-state-hover-surface)] hover:text-[var(--trinity-state-hover-foreground)] disabled:pointer-events-none disabled:opacity-[var(--trinity-disabled-opacity)] aria-selected:bg-[var(--trinity-state-selected-surface)] aria-selected:text-[var(--trinity-state-selected-foreground)] pointer-coarse:min-h-11',
  );
}
