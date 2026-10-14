import { scrollBehavior } from '@trinity/util/ui';

/**
 * Scroll a jump target into view. A row that fits is centred. A row taller than the
 * scroller's visible height (a long message, expanded because it was jumped to) is aligned by
 * its top instead, so the reader starts at the beginning of the message rather than mid-way.
 */
export function scrollToJumpTarget(target: Element, scroller: Element): void {
  const tall = target.getBoundingClientRect().height > scroller.clientHeight;
  target.scrollIntoView({
    behavior: scrollBehavior(),
    block: tall ? 'start' : 'center',
  });
}
