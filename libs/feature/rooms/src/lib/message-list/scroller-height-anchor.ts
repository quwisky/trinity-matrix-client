/**
 * Observe a message viewport and preserve the only height-resize case the browser cannot
 * infer: a conversation that was pinned to the newest message must remain pinned when its
 * composer or the software keyboard changes the viewport height. A scrolled-up viewport is
 * deliberately left alone because its top edge and scrollTop already preserve the reading
 * anchor.
 */
export function observeScrollerHeight(
  element: HTMLElement,
  resized?: (height: number, scrollTop: number) => void,
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
    // The 120px "near bottom" threshold used for incoming messages is deliberately not
    // this predicate. Composer growth may pin only an EXACTLY bottom-anchored reader; even
    // one pixel up is an intentional reading position. Use the previous viewport height
    // because ResizeObserver runs after the new height has already been applied.
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
      // A pointer/wheel event can move the reader after ResizeObserver delivery but before
      // paint. A changed scrollTop is direct evidence of that input, so queued work must not
      // undo it. Keeping the sampled value also carries an exact pin through several resize
      // deliveries in the same frame (the software keyboard commonly emits a sequence).
      if (element.scrollTop !== pendingScrollTop) {
        pendingScrollTop = null;
        resized?.(element.clientHeight, element.scrollTop);
        return;
      }
      element.scrollTop = element.scrollHeight - element.clientHeight;
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
