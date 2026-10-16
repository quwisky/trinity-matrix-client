import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** A press longer than this is a hold or a drag; the latch must not outlive it. */
export const PRESS_WATCHDOG_MS = 1_000;

/**
 * Whether a pointer is pressed anywhere in the page. Layout owners that would move content
 * under a tap (the global banner slot) hold their change until release, so a press and its
 * release always land on the same target. Each pointer is tracked by its id, so lifting one
 * of two fingers keeps the press. A pointer's press ends on its up, cancel (the browser took
 * the gesture for a scroll) or lost capture; window blur, a hidden page and a watchdog for
 * anything else end every press.
 */
@Injectable({ providedIn: 'root' })
export class PointerPressService {
  private readonly pointers = new Set<number>();
  private readonly pressedSig = signal(false);
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  readonly pressed = this.pressedSig.asReadonly();

  constructor() {
    const doc = inject(DOCUMENT);
    const view = doc.defaultView;
    const down = (event: Event): void => this.press(pointerIdOf(event));
    const up = (event: Event): void => this.lift(pointerIdOf(event));
    const releaseAll = (): void => this.releaseAll();
    const options = { capture: true, passive: true } as const;
    const ends = ['pointerup', 'pointercancel', 'lostpointercapture'] as const;
    doc.addEventListener('pointerdown', down, options);
    for (const type of ends) doc.addEventListener(type, up, options);
    doc.addEventListener('visibilitychange', releaseAll, options);
    view?.addEventListener('blur', releaseAll);
    inject(DestroyRef).onDestroy(() => {
      doc.removeEventListener('pointerdown', down, options);
      for (const type of ends) doc.removeEventListener(type, up, options);
      doc.removeEventListener('visibilitychange', releaseAll, options);
      view?.removeEventListener('blur', releaseAll);
      this.clearWatchdog();
    });
  }

  private press(pointerId: number): void {
    this.pointers.add(pointerId);
    this.pressedSig.set(true);
    this.clearWatchdog();
    this.watchdog = setTimeout(() => this.releaseAll(), PRESS_WATCHDOG_MS);
  }

  private lift(pointerId: number): void {
    this.pointers.delete(pointerId);
    if (this.pointers.size === 0) this.releaseAll();
  }

  private releaseAll(): void {
    this.pointers.clear();
    this.clearWatchdog();
    this.pressedSig.set(false);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}

/** A pointer event's id; events without one (synthetic ones) share a single id. */
function pointerIdOf(event: Event): number {
  const id = (event as Partial<PointerEvent>).pointerId;
  return typeof id === 'number' ? id : -1;
}
