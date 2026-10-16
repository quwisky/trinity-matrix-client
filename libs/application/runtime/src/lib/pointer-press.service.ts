import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** A press longer than this is a hold or a drag; the latch must not outlive it. */
export const PRESS_WATCHDOG_MS = 1_000;

/**
 * Whether a pointer is pressed anywhere in the page. Layout owners that would move content
 * under a tap (the global banner slot) hold their change until release, so a press and its
 * release always land on the same target. Every path out of a press releases it: up, cancel
 * (the browser took the gesture for a scroll), lost capture, window blur, a hidden page, and
 * a watchdog for anything else.
 */
@Injectable({ providedIn: 'root' })
export class PointerPressService {
  private readonly pressedSig = signal(false);
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  readonly pressed = this.pressedSig.asReadonly();

  constructor() {
    const doc = inject(DOCUMENT);
    const view = doc.defaultView;
    const down = (): void => this.press();
    const up = (): void => this.release();
    const options = { capture: true, passive: true } as const;
    doc.addEventListener('pointerdown', down, options);
    for (const type of [
      'pointerup',
      'pointercancel',
      'lostpointercapture',
      'visibilitychange',
    ]) {
      doc.addEventListener(type, up, options);
    }
    view?.addEventListener('blur', up);
    inject(DestroyRef).onDestroy(() => {
      doc.removeEventListener('pointerdown', down, options);
      for (const type of [
        'pointerup',
        'pointercancel',
        'lostpointercapture',
        'visibilitychange',
      ]) {
        doc.removeEventListener(type, up, options);
      }
      view?.removeEventListener('blur', up);
      this.clearWatchdog();
    });
  }

  private press(): void {
    this.pressedSig.set(true);
    this.clearWatchdog();
    this.watchdog = setTimeout(() => this.release(), PRESS_WATCHDOG_MS);
  }

  private release(): void {
    this.clearWatchdog();
    this.pressedSig.set(false);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}
