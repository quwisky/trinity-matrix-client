import { hlm } from '@trinity/helm/utils';

/** `segmented`: filled pills. `underline`: a divided strip with an accent bar under the selected tab. */
export type TrnTabsAppearance = 'segmented' | 'underline';

/** No track; each tab takes an equal share. */
export function trnTabListRecipe(
  appearance: TrnTabsAppearance = 'segmented',
): string {
  return appearance === 'underline'
    ? hlm('flex border-b border-[var(--trinity-border-overlay)]')
    : hlm('flex gap-1');
}

/** Focus uses the global keyboard ring. */
export function trnTabRecipe(
  appearance: TrnTabsAppearance = 'segmented',
): string {
  const shared =
    'inline-flex min-h-9 flex-1 items-center justify-center px-3 text-sm text-[var(--trinity-text-muted)] disabled:pointer-events-none disabled:opacity-[var(--trinity-disabled-opacity)] pointer-coarse:min-h-11';
  // The bar overlaps the list's divider (-mb-px), so the selected tab reads as joined to it.
  return appearance === 'underline'
    ? hlm(
        shared,
        '-mb-px min-h-10 border-b-2 border-transparent font-medium hover:text-[var(--trinity-text)] aria-selected:border-[var(--trinity-accent)] aria-selected:text-[var(--trinity-text-bright)]',
      )
    : hlm(
        shared,
        'rounded-[var(--trinity-shape-control-radius)] font-semibold hover:bg-[var(--trinity-state-hover-surface)] hover:text-[var(--trinity-state-hover-foreground)] aria-selected:bg-[var(--trinity-state-selected-surface)] aria-selected:text-[var(--trinity-state-selected-foreground)]',
      );
}
