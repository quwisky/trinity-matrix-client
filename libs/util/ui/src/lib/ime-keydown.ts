/**
 * Whether this keydown belongs to an IME (Japanese, Chinese, Korean input), such as the Enter
 * that accepts a candidate: it must not send, submit or otherwise act.
 *
 * WebKit (Safari, iOS) fires `compositionend` before that keydown, so `isComposing` is already
 * false there and only the legacy `keyCode` 229 identifies it.
 */
export function isImeKeydown(event: Event): boolean {
  const key = event as KeyboardEvent;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- nothing else marks WebKit's post-composition keydown
  return key.isComposing || key.keyCode === 229;
}
