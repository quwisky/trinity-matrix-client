import { scrollBehavior } from '@trinity/util/ui';

/**
 * Scroll a jump target into view: centred when it fits, aligned by its top when taller than the
 * scroller (a long, expanded message) so the reader starts at its beginning.
 */
// A browser-animated smooth scroll has no single delta to report to the scroll-speed estimate,
// so its movement reads as scrolling (images under "Load images after fast scrolling" load once it settles).
export function scrollToJumpTarget(target: Element, scroller: Element): void {
  const tall = target.getBoundingClientRect().height > scroller.clientHeight;
  target.scrollIntoView({
    behavior: scrollBehavior(),
    block: tall ? 'start' : 'center',
  });
}
