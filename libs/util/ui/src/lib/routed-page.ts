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
