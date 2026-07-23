import { DOCUMENT } from '@angular/common';
import { Directive, DestroyRef, inject, input, output } from '@angular/core';

/** How long a press must be held before it counts as a long press. */
const DEFAULT_DELAY_MS = 500;

/** How far the pointer may drift before the press is treated as a scroll/drag. */
const MOVE_TOLERANCE_PX = 10;

/**
 * Press-and-hold gesture for touch and pen input.
 *
 * The secondary action on a control whose tap is already taken — a reaction pill taps
 * to toggle your own reaction, so "who reacted" hangs off a long press instead. Mouse
 * input is deliberately ignored: a slow click there must keep behaving like a click,
 * and a pointer has better affordances (hover, context menus) available anyway.
 *
 * The press is abandoned if the pointer lifts early, is cancelled by the browser
 * (a scroll taking over), leaves the element, or drifts more than
 * {@link MOVE_TOLERANCE_PX}. Once it fires, the `click` the browser synthesises when
 * the finger lifts is swallowed, so the host's own tap handler doesn't also run.
 */
@Directive({
  selector: '[trnLongPress]',
  host: {
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerUp()',
    '(pointercancel)': 'onPointerUp()',
    '(pointerleave)': 'cancel()',
    '(contextmenu)': 'onContextMenu($event)',
  },
})
export class LongPressDirective {
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  /** How long the press must be held, in milliseconds. */
  readonly longPressDelay = input(DEFAULT_DELAY_MS);
  /** The press was held long enough (touch/pen only). */
  readonly longPress = output<void>();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private origin: { x: number; y: number } | null = null;
  /** Whether the click guard below is currently installed. */
  private guarding = false;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.clearTimer();
      this.releaseClickGuard();
    });
  }

  onPointerDown(event: Event): void {
    const pointer = event as PointerEvent;
    // Mouse presses are left alone entirely — clicking, however slowly, stays a click.
    if (pointer.pointerType === 'mouse') {
      return;
    }
    this.clearTimer();
    this.origin = { x: pointer.clientX, y: pointer.clientY };
    this.timer = setTimeout(() => {
      this.timer = null;
      this.origin = null;
      this.armClickGuard();
      this.longPress.emit();
    }, this.longPressDelay());
  }

  onPointerMove(event: Event): void {
    const pointer = event as PointerEvent;
    if (!this.origin) {
      return;
    }
    const drift = Math.hypot(
      pointer.clientX - this.origin.x,
      pointer.clientY - this.origin.y,
    );
    if (drift > MOVE_TOLERANCE_PX) {
      this.cancel();
    }
  }

  /** The finger lifted: end any pending press, and stop guarding once the click
   * that belongs to this gesture has had its chance to arrive (it is dispatched
   * synchronously after `pointerup`, so a macrotask later is safely after it). */
  onPointerUp(): void {
    this.cancel();
    if (this.guarding) {
      setTimeout(() => this.releaseClickGuard());
    }
  }

  /** Abandon a press in progress. */
  cancel(): void {
    this.clearTimer();
    this.origin = null;
  }

  /** Long-pressing on touch can raise a context menu — suppress it mid-press. */
  onContextMenu(event: Event): void {
    if (this.timer !== null || this.guarding) {
      event.preventDefault();
    }
  }

  /**
   * Swallow the next click anywhere in the document.
   *
   * It has to be a capture-phase listener on the document rather than one on the host:
   * stopping propagation there keeps the event from reaching the host at all, whereas a
   * host listener races the host's own `(click)` binding — and `stopImmediatePropagation`
   * doesn't reliably reach a sibling listener registered by Angular.
   */
  private armClickGuard(): void {
    if (this.guarding) {
      return;
    }
    this.guarding = true;
    this.document.addEventListener('click', this.swallowClick, true);
  }

  private releaseClickGuard(): void {
    if (!this.guarding) {
      return;
    }
    this.guarding = false;
    this.document.removeEventListener('click', this.swallowClick, true);
  }

  private readonly swallowClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    this.releaseClickGuard();
  };

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
