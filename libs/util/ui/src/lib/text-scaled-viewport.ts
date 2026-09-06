import { DestroyRef, signal, type Signal } from '@angular/core';

/**
 * Whether a viewport can fit `minWidthRem` at the current document text size.
 * CSS media-query rem units use the browser's initial font size, so they do not
 * follow Trinity's root-font-size preference. Keep presentation and navigation
 * on this same signal when a layout must also adapt to larger application text.
 */
export function textScaledViewportSignal(
  minWidthRem: number,
  destroyRef: DestroyRef,
): Signal<boolean> {
  const wide = signal(false);
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return wide.asReadonly();
  }
  const root = document.documentElement;
  const refresh = (): void => {
    const fontSize =
      Number.parseFloat(window.getComputedStyle(root).fontSize) || 16;
    wide.set(window.innerWidth >= minWidthRem * fontSize);
  };
  refresh();
  const observer = new MutationObserver(refresh);
  observer.observe(root, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
  window.addEventListener('resize', refresh);
  destroyRef.onDestroy(() => {
    observer.disconnect();
    window.removeEventListener('resize', refresh);
  });
  return wide.asReadonly();
}
