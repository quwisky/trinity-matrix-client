import { matchesQuery } from './media-query';

/**
 * The one motion decision CSS cannot make for us. `global.scss`'s `prefers-reduced-motion` reset
 * sets `scroll-behavior: auto !important`, but `scrollTo({ behavior: 'smooth' })` and
 * `scrollIntoView({ behavior: 'smooth' })` pass the behaviour as an ARGUMENT, which wins over
 * the stylesheet however many `!important`s the reset carries. The timeline's JS-driven scrolls
 * must consult this instead.
 */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether the user has asked for less motion, read at the moment of the call so a preference
 * changed mid-session applies to the next scroll. No signal or `DestroyRef` is needed for these
 * one-shot imperative calls.
 *
 * Reads through `matchesQuery`; a context without `matchMedia` reads `false`, the safe answer
 * (smooth scrolling).
 */
export function prefersReducedMotion(): boolean {
  return matchesQuery(REDUCED_MOTION_QUERY);
}

/**
 * The `behavior` to hand a programmatic scroll: `auto` (a jump) when the user has asked for less
 * motion, `smooth` otherwise. Keeps the choice identical at every call site; a hard-coded
 * `'smooth'` is not obviously wrong when read.
 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
