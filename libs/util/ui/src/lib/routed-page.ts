/** Class on the element a `<router-outlet>` renders; global.scss gives it the page layout. */
export const ROUTED_PAGE_CLASS = 'trn-routed-page';

/**
 * Call from `(activate)` with the outlet element. Angular renders the routed page as the
 * outlet's next sibling; a class keeps the layout rule non-positional, so inserting or
 * removing rows elsewhere never makes the browser re-match a sibling selector.
 */
export function markRoutedPage(outlet: Element): void {
  outlet.nextElementSibling?.classList.add(ROUTED_PAGE_CLASS);
}

/**
 * Router `info` for a navigation the person did not make, such as Workspace repairing a
 * destination that became unavailable. Post-navigation focus handling leaves focus where
 * it is for it. Router keeps `info` by reference and never persists it, so identity marks it.
 */
export const BACKGROUND_NAVIGATION_INFO: object = Object.freeze({
  background: true,
});

/** Whether a navigation's Router `info` marks it as one the person did not make. */
export function isBackgroundNavigation(info: unknown): boolean {
  return info === BACKGROUND_NAVIGATION_INFO;
}
