// @trinity/components/utils — the class plumbing every wrapper in this tier uses.
//
// Re-exported from the vendored kit rather than copied, and that is a correctness
// requirement rather than laziness. `classes()` keeps MODULE-SCOPED state: a per-element
// manager map, an ordering counter, and one document-wide MutationObserver. A second copy
// would install a second observer and a second manager for the same elements, and any host
// where a wrapper and the kit directive it composes both apply classes would have two
// independent writers racing over `className` — last write wins, and the loser's classes
// vanish with no error.
//
// So there is exactly one implementation in the process. What this file buys is the NAME:
// call sites in `libs/components/*` say `trn()`/`classes()` from their own tier, and the
// day the kit goes, this is the single file that has to grow a real implementation.
export { classes, hlm as trn } from '@trinity/helm/utils';
