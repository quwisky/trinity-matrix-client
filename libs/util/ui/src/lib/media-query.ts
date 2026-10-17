import { DestroyRef, signal, type Signal } from '@angular/core';

/**
 * The app's `md` breakpoint. At or above it the rooms sidebar and settings are static columns
 * beside their detail pane; below it each is a full-screen page shown one at a time.
 */
export const MD_QUERY = '(min-width: 768px)';

/**
 * The exact complement of {@link MD_QUERY}. CSS media queries are inclusive at both ends, so
 * `767.98px` is what pairs with `768px` without a fractional device-pixel width where both
 * match, or neither does.
 */
export const BELOW_MD_QUERY = '(max-width: 767.98px)';

/**
 * The second boundary the rooms shell turns on: whether there is room for a third column. At or
 * above it the member list is a static column beside the timeline; below it, an overlay drawer.
 * The width follows from what has to fit (72px rail, 280px room list, a readable timeline,
 * 240px member column).
 *
 * Keep in step with the Tailwind variant `--breakpoint-members` (Theme Foundation's Tailwind
 * adapter) and `$below-members` in the rooms feature's shared SCSS. Media queries cannot read a
 * custom property; `scripts/breakpoints.spec.mjs` stops the three drifting apart.
 *
 * Only the BELOW direction has app-code callers (its `false` is the safe fallback). This one
 * stays exported as the anchor the guard compares against, so a min and a max cannot drift
 * apart unnoticed.
 */
export const MEMBERS_QUERY = '(min-width: 1100px)';

/**
 * The exact complement of {@link MEMBERS_QUERY}, on the same `.02px` convention as
 * {@link BELOW_MD_QUERY}; `scripts/breakpoints.spec.mjs` pins how it relates to the CSS variant.
 * 1100px itself is the column layout, not the drawer.
 */
export const BELOW_MEMBERS_QUERY = '(max-width: 1099.98px)';

/**
 * A signal tracking `query`, kept live until `destroyRef` fires, so rotating a phone or dragging
 * a window across the breakpoint re-renders.
 *
 * The caller passes its own `DestroyRef` (`mediaQuerySignal(BELOW_MD_QUERY, inject(DestroyRef))`)
 * so this library stays `type:util`, where nothing needs Angular DI, and the call may sit in a
 * method or `computed` without throwing NG0203.
 *
 * `matchMedia` is feature-detected so non-DOM contexts read `false` rather than throwing, so
 * callers must pick the query whose `false` is the safe fallback. `addEventListener` is
 * feature-detected *separately* because specs stub `matchMedia` as a bare
 * `vi.fn().mockReturnValue({ matches })` with no event API.
 */
export function mediaQuerySignal(
  query: string,
  destroyRef: DestroyRef,
): Signal<boolean> {
  const list =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query)
      : null;
  // One MediaQueryList seeds the signal and carries the listener, so the two cannot disagree.
  const matches = signal(list?.matches ?? false);
  if (typeof list?.addEventListener === 'function') {
    const onChange = (event: MediaQueryListEvent): void =>
      matches.set(event.matches);
    list.addEventListener('change', onChange);
    destroyRef.onDestroy(() => list.removeEventListener('change', onChange));
  }
  return matches.asReadonly();
}

/**
 * Whether `query` matches RIGHT NOW, with no subscription and no lifetime to manage. Use it only
 * for an intentional snapshot; state that must follow viewport changes uses
 * {@link mediaQuerySignal}.
 *
 * Without `matchMedia` it reads `false`, so pick the direction whose `false` is the safe
 * fallback.
 */
export function matchesQuery(query: string): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(query).matches
  );
}
