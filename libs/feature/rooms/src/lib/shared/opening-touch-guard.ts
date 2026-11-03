/** The most a hold may keep its guard if no pointer end is ever seen. */
const FALLBACK_MS = 10_000;
/** How long after the lift its click may still arrive. */
const CLICK_GRACE_MS = 300;
const NO_SELECT = [
  'user-select',
  '-webkit-user-select',
  '-webkit-touch-callout',
] as const;

/**
 * Keep a long press that just opened a sheet from acting on the sheet that is now under the finger.
 *
 * The finger is still down when the sheet appears, and the browser carries the same touch on: iOS
 * WebKit turns the hold into a text selection and callout on whatever is now under it, and the lift
 * becomes a click on the sheet row or backdrop there (#1868). Until that pointer lifts this stops
 * selection, the callout and the lift's click, then clears any selection the hold still made. A new
 * press, or the fallback when no end arrives, hands everything back at once.
 *
 * Returns the release, for an owner torn down mid-hold.
 */
export function guardOpeningTouch(pointerId: number): () => void {
  const body = document.body;
  const hadSelection = !(document.getSelection()?.isCollapsed ?? true);
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let released = false;

  const swallow = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  const swallowClick = (event: Event): void => {
    swallow(event);
    release();
  };
  // Its click follows at once, so stop swallowing shortly after.
  const lifted = (event: PointerEvent): void => {
    if (event.pointerId === pointerId && graceTimer === null) {
      graceTimer = setTimeout(release, CLICK_GRACE_MS);
    }
  };
  // A new pointer means the held one's end was lost; nothing may be swallowed on its behalf.
  const otherDown = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) release();
  };
  const listeners = [
    ['click', swallowClick],
    ['selectstart', swallow],
    ['contextmenu', swallow],
    ['pointerdown', otherDown],
    ['pointerup', lifted],
    ['pointercancel', lifted],
  ] as const;
  const fallback = setTimeout(release, FALLBACK_MS);

  function release(): void {
    if (released) return;
    released = true;
    clearTimeout(fallback);
    if (graceTimer !== null) clearTimeout(graceTimer);
    for (const [type, listener] of listeners) {
      document.removeEventListener(type, listener as EventListener, true);
    }
    for (const name of NO_SELECT) body.style.removeProperty(name);
    // Only a range the hold made: a caret (the composer's) is collapsed and stays.
    const selection = document.getSelection();
    if (!hadSelection && selection && !selection.isCollapsed) {
      selection.removeAllRanges();
    }
  }

  for (const [type, listener] of listeners) {
    document.addEventListener(type, listener as EventListener, true);
  }
  for (const name of NO_SELECT) body.style.setProperty(name, 'none');
  return release;
}
