/**
 * Whether the window has focus, so the person can be looking at an open conversation.
 * Read receipts wait for it: a window in the background or behind another has none.
 * True outside a browser, where there is no window to wait for.
 */
export function windowHasFocus(): boolean {
  return typeof document === 'undefined' || document.hasFocus();
}

/**
 * Call `listener` each time the window regains focus, to send the receipt that
 * {@link windowHasFocus} held back. Returns the function that stops listening.
 */
export function onWindowFocus(listener: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }
  window.addEventListener('focus', listener);
  return () => window.removeEventListener('focus', listener);
}
