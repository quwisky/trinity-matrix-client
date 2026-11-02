/** How far a finger must travel down the list before the keyboard goes: well past a tap's wobble. */
export const DRAG_DISMISS_PX = 40;

/**
 * Dismiss the software keyboard when the reader drags the list down, as phones do. Only blurs the
 * focused field, so the scroll itself is untouched; sideways drags (message swipes) never count.
 * Returns the cleanup.
 */
export function dismissKeyboardOnDrag(el: HTMLElement): () => void {
  let from: { x: number; y: number } | null = null;
  const start = (event: TouchEvent): void => {
    const touch = event.touches[0];
    from =
      touch && event.touches.length === 1
        ? { x: touch.clientX, y: touch.clientY }
        : null;
  };
  const move = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (!from || !touch) return;
    const down = touch.clientY - from.y;
    if (down > DRAG_DISMISS_PX && down > Math.abs(touch.clientX - from.x)) {
      from = null;
      const field = el.ownerDocument.activeElement;
      if (
        field instanceof HTMLElement &&
        field.matches('input, textarea, [contenteditable]')
      ) {
        field.blur();
      }
    }
  };
  const end = (): void => {
    from = null;
  };
  const passive = { passive: true } as const;
  el.addEventListener('touchstart', start, passive);
  el.addEventListener('touchmove', move, passive);
  el.addEventListener('touchend', end, passive);
  el.addEventListener('touchcancel', end, passive);
  return () => {
    el.removeEventListener('touchstart', start);
    el.removeEventListener('touchmove', move);
    el.removeEventListener('touchend', end);
    el.removeEventListener('touchcancel', end);
  };
}
