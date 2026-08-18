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
