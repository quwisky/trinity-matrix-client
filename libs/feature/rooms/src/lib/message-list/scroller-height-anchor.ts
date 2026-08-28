/**
 * Observe a message viewport and preserve the only height-resize case the browser cannot
 * infer: a conversation that was pinned to the newest message must remain pinned when its
 * composer or the software keyboard changes the viewport height. A scrolled-up viewport is
 * deliberately left alone because its top edge and scrollTop already preserve the reading
 * anchor.
 */
export function observeScrollerHeight(
  element: HTMLElement,
  isPinned: () => boolean,
  resized?: (height: number, scrollTop: number) => void,
): () => void {
  let lastHeight = element.clientHeight;
  resized?.(element.clientHeight, element.scrollTop);
  if (typeof ResizeObserver === 'undefined') {
    return () => undefined;
  }

  const observer = new ResizeObserver(() => {
    const height = element.clientHeight;
    if (height === lastHeight) {
      return;
    }
    lastHeight = height;
    if (!isPinned()) {
      resized?.(height, element.scrollTop);
      return;
    }
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
      resized?.(element.clientHeight, element.scrollTop);
    });
  });
  observer.observe(element);
  return () => observer.disconnect();
}
