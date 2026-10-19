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
  // An underline strip often runs edge to edge in a clipping scroller, so its ring is inset.
  // Forced colours drop the accent; the bar takes the system's selection colour instead.
  return appearance === 'underline'
    ? hlm(
        shared,
        '-mb-px min-h-10 border-b-2 border-transparent font-medium hover:text-[var(--trinity-text)] focus-visible:outline-offset-[calc(-1*var(--trinity-focus-ring-width))] aria-selected:border-[var(--trinity-accent)] aria-selected:text-[var(--trinity-text-bright)] forced-colors:border-b-[Canvas] forced-colors:aria-selected:border-b-[Highlight]',
      )
    : hlm(
        shared,
        'rounded-[var(--trinity-shape-control-radius)] font-semibold hover:bg-[var(--trinity-state-hover-surface)] hover:text-[var(--trinity-state-hover-foreground)] aria-selected:bg-[var(--trinity-state-selected-surface)] aria-selected:text-[var(--trinity-state-selected-foreground)]',
      );
}
