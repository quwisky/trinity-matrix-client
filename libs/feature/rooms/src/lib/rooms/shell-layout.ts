/**
 * Viewport predicates the rooms shell branches on.
 *
 * DI-free and evaluated at call time, not at module load: the specs swap `window.matchMedia`
 * between tests to drive the narrow layout, and a value captured at import would freeze the
 * first answer for the whole file.
 */

/** True when the member list is currently the overlay drawer rather than the static
 * column — mirrors the `max-width: 1100px` query the drawer styling uses. Feature-detects
 * matchMedia so non-DOM contexts fall back to the static column. */
export function membersShownAsDrawer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 1100px)').matches
  );
}

/** The member list is a static column above the drawer cutoff (shown by default) and an
 * overlay drawer at/below it (starts closed). Derived as the exact complement of
 * membersShownAsDrawer so the two share one boundary with no sub-pixel gap between them. */
export function membersColumnDefaultsOpen(): boolean {
  return !membersShownAsDrawer();
}

/** True on the mobile master-detail layout (below md), where the room list and the
 * chat are separate full-screen pages — mirrors the `max-width: 767.98px` scss query. */
export function isMobileMasterDetail(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 767.98px)').matches
  );
}
