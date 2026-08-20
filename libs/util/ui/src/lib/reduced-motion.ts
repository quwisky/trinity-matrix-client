/**
 * The one motion decision CSS cannot make for us.
 *
 * `global.scss` carries the usual `prefers-reduced-motion` reset — it flattens every
 * animation and transition in the app, and sets `scroll-behavior: auto !important`. That
 * last one looks like it covers scrolling, and it does not: `scroll-behavior` is the CSS
 * property, and an element's own `scrollTo({ behavior: 'smooth' })` or
 * `scrollIntoView({ behavior: 'smooth' })` passes the behaviour as an ARGUMENT, which wins
 * over the stylesheet no matter how many `!important`s the reset carries.
 *
 * The timeline scrolls itself from JavaScript in five places — jumping to a reply, to a
 * search hit, to a pinned message, to the newest message, and to a thread root — so a reader
 * who asked the operating system for less motion got a full-screen animated scroll every
 * time anyway. These are the sites the CSS reset was never able to reach.
 */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether the user has asked for less motion, read at the moment of the call.
 *
 * Read fresh rather than cached in a signal: these are one-shot imperative calls made at
 * scroll time, so there is nothing to keep live and no `DestroyRef` to thread through — and
 * reading now means a preference changed mid-session takes effect on the next scroll rather
 * than at the next reload.
 *
 * `matchMedia` is feature-detected, matching `mediaQuerySignal` next door: a context without
 * it reads `false`, and `false` is the safe answer here because it yields the behaviour the
 * app had before this existed.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

/**
 * The `behavior` to hand a programmatic scroll: `auto` — which means jump — when the user
 * has asked for less motion, and `smooth` otherwise.
 *
 * Exists so the choice is made identically at all five call sites. A site that hard-codes
 * `'smooth'` is not obviously wrong when you read it, which is exactly how all five came to.
 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
