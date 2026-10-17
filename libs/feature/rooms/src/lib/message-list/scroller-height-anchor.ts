/**
 * Keep a conversation pinned to the newest message when its composer or the software keyboard
 * changes the viewport height: the one height-resize case the browser cannot infer. A scrolled-up
 * viewport is left alone, since its top edge and scrollTop already preserve the reading anchor.
 */
export function observeScrollerHeight(
  element: HTMLElement,
  resized?: (height: number, scrollTop: number) => void,
  /** Told how far the pin moved the scroll position, as it moves it (not the reader's doing). */
  wrote?: (delta: number) => void,
): () => void {
  let lastHeight = element.clientHeight;
  let pendingFrame: number | null = null;
  let pendingScrollTop: number | null = null;
  resized?.(element.clientHeight, element.scrollTop);
  if (typeof ResizeObserver === 'undefined') {
    return () => undefined;
  }

  const observer = new ResizeObserver(() => {
    const height = element.clientHeight;
    if (height === lastHeight) {
      return;
    }
    // Not the 120px "near bottom" threshold used for incoming messages: composer growth pins only
    // an EXACTLY bottom-anchored reader; even one pixel up is an intentional reading position. Uses
    // the previous viewport height because ResizeObserver runs after the new height is applied.
    const wasPinned =
      element.scrollHeight - element.scrollTop - lastHeight < 1 ||
      (pendingFrame !== null && element.scrollTop === pendingScrollTop);
    lastHeight = height;
    if (pendingFrame !== null) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    }
    if (!wasPinned) {
      resized?.(height, element.scrollTop);
      return;
    }
    pendingScrollTop = element.scrollTop;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      // A pointer/wheel event can move the reader after ResizeObserver delivery but before paint;
      // a changed scrollTop is evidence of that input, so queued work must not undo it. Keeping the
      // sampled value also carries an exact pin through several resize deliveries in one frame
      // (the software keyboard commonly emits a sequence).
      if (element.scrollTop !== pendingScrollTop) {
        pendingScrollTop = null;
        resized?.(element.clientHeight, element.scrollTop);
        return;
      }
      const before = element.scrollTop;
      element.scrollTop = element.scrollHeight - element.clientHeight;
      wrote?.(element.scrollTop - before);
      pendingScrollTop = null;
      resized?.(element.clientHeight, element.scrollTop);
    });
  });
  observer.observe(element);
  return () => {
    observer.disconnect();
    if (pendingFrame !== null) {
      cancelAnimationFrame(pendingFrame);
    }
  };
}
