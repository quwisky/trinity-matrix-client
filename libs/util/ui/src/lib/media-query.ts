import { DestroyRef, signal, type Signal } from '@angular/core';

/**
 * The app's `md` breakpoint — the one boundary the whole shell turns on. At or above it the
 * rooms sidebar and settings are static columns beside their detail pane; below it each is a
 * full-screen page shown one at a time.
 */
export const MD_QUERY = '(min-width: 768px)';

/**
 * The exact complement of {@link MD_QUERY}. Both directions are exported because CSS media
 * queries are inclusive at both ends: `767.98px` is what pairs with `768px` without leaving a
 * fractional device-pixel width where both match, or neither does.
 */
export const BELOW_MD_QUERY = '(max-width: 767.98px)';

/**
 * The second boundary the rooms shell turns on: whether there is room for a third column.
 *
 * At or above it the member list is a static column beside the timeline; below it the same
 * list is an overlay drawer over the timeline. Named `members` rather than by its width
 * because the number is a consequence of what has to fit — a 72px rail, a 280px room list, a
 * timeline wide enough to read, and a 240px member column — not a decision of its own.
 *
 * Paired with the Tailwind variant of the same name (`--breakpoint-members` in
 * Theme Foundation's Tailwind adapter) and with `$below-members` in the rooms feature's
 * shared SCSS. Media queries cannot read a custom property, so the value genuinely exists
 * three times; `scripts/breakpoints.spec.mjs` is what stops the three drifting apart.
 *
 * Only the BELOW direction has app-code callers today — every branch on this boundary wants
 * the answer whose `false` is the safe fallback, which is the other constant. This one is
 * exported anyway for the same reason `MD_QUERY` is: it is the definitional anchor the guard
 * compares `--breakpoint-members` against, and a pair with one half missing is the shape
 * that lets a min and a max drift apart unnoticed.
 */
export const MEMBERS_QUERY = '(min-width: 1100px)';

/**
 * The exact complement of {@link MEMBERS_QUERY}, on the same `.02px` convention as
 * {@link BELOW_MD_QUERY} — and the same convention Tailwind's own `max-*` variants use, so
 * `max-members:` and this constant describe one boundary rather than two a pixel apart.
 *
 * Note this moved the boundary by a pixel: the hand-rolled query it replaces was
 * `(max-width: 1100px)`, which made 1100px itself the drawer layout. It is now the column,
 * matching `MEMBERS_QUERY` and the Tailwind variant.
 */
export const BELOW_MEMBERS_QUERY = '(max-width: 1099.98px)';

/**
 * A signal tracking `query`, kept live until `destroyRef` fires — so rotating a phone or
 * dragging a window across the breakpoint re-renders, rather than stranding the layout the
 * page happened to load with.
 *
 * The caller passes its own `DestroyRef` (`mediaQuerySignal(BELOW_MD_QUERY, inject(DestroyRef))`)
 * rather than this reaching for one. That is the convention `runWithBusy` next door already
 * uses, and it is what keeps this library `type:util`, whose contract is that nothing in it
 * needs Angular DI. It also removes a trap the injecting version carried: that one had to be
 * called from a field initializer, and moving the call into a method or a `computed` threw
 * NG0203 at runtime with nothing at compile time to say so.
 *
 * `matchMedia` is feature-detected so non-DOM contexts read `false` rather than throwing —
 * which means callers must pick the query whose `false` is the safe fallback, hence both
 * directions above. `addEventListener` is feature-detected *separately* because specs across
 * this repo stub `matchMedia` as `vi.fn().mockReturnValue({ matches })`: a bare object with no
 * event API, and a fixed value is exactly right for them.
 */
export function mediaQuerySignal(
  query: string,
  destroyRef: DestroyRef,
): Signal<boolean> {
  const list =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query)
      : null;
  // One MediaQueryList both seeds the signal and carries the listener, so there is no window
  // in which the two disagree.
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
 * Whether `query` matches RIGHT NOW, with no subscription and no lifetime to manage.
 *
 * The one-shot counterpart to {@link mediaQuerySignal}. Use it only when the caller
 * intentionally needs a snapshot; responsive state that must follow viewport changes uses
 * the signal form and applies any user-state policy explicitly.
 *
 * `matchMedia` is feature-detected on the same terms as the signal above: a context without
 * it reads `false`, so callers must pick the direction whose `false` is the safe fallback.
 */
export function matchesQuery(query: string): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(query).matches
  );
}
