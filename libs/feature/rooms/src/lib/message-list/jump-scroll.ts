import { scrollBehavior } from '@trinity/util/ui';

/**
 * Scroll a jump target into view. A row that fits is centred. A row taller than the
 * scroller's visible height (a long message, expanded because it was jumped to) is aligned by
 * its top instead, so the reader starts at the beginning of the message rather than mid-way.
 */
// A smooth scroll animated by the browser: unlike the list's own one-off writes it has no
// single delta to report to the scroll-speed estimate, so its movement reads as scrolling
// (images under "Load images after fast scrolling" load once it settles).
export function scrollToJumpTarget(target: Element, scroller: Element): void {
  const tall = target.getBoundingClientRect().height > scroller.clientHeight;
  target.scrollIntoView({
    behavior: scrollBehavior(),
    block: tall ? 'start' : 'center',
  });
}
