import { Injectable } from '@angular/core';

/**
 * Faster than anyone reads: about two viewports a second. Below it the reader may be reading,
 * so work held back during a fast scroll (images, full rows) goes ahead.
 */
export const READING_SPEED_PX_PER_S = 1_500;

/** How quickly the speed estimate follows a change of speed: about one estimate per 100 ms. */
const SPEED_SMOOTHING_MS = 100;

/**
 * A scroll event this long after the previous one starts a new estimate: the reader paused
 * (or the scroll had already settled), so the gap says nothing about how fast they move now.
 */
const SAMPLE_GAP_MS = 150;

/**
 * Whether the timeline is mid-scroll, and how fast, shared by the message list with its rows.
 *
 * A scroll slides a new row under a still pointer almost every frame, and mounting a hover toolbar
 * and arming a time tooltip for each costs a style recalculation and layout per frame. While the
 * list scrolls, a row the pointer enters defers that work here; only the latest row is kept (one row
 * holds the pointer) and it runs once the scroll settles.
 *
 * The list also reports where the reader has moved it ({@link moved}), so work only a reader can
 * use (an image) can wait while the list moves faster than anyone reads ({@link speed}). Positions
 * the list writes itself (a pin, a height correction, a jump) are taken out as written
 * ({@link shifted}), so they never read as speed, even when the browser reports one together with
 * the reader's own movement.
 *
 * Plain fields, not signals: nothing renders from this state, so scroll events must not schedule
 * change detection through it. Code that must act when the scroll slows down {@link watch}es it.
 */
@Injectable()
export class TimelineScrollActivity {
  private scrolling = false;
  private deferred: (() => void) | null = null;
  private speedPxPerS = 0;
  /** The last position and when it was reached, or null when no estimate is running. */
  private last: { readonly top: number; readonly at: number } | null = null;
  private readonly watchers = new Set<() => void>();

  /** Whether the list has scrolled within its idle window. */
  get active(): boolean {
    return this.scrolling;
  }

  /** How fast the reader is moving the list, in px/s, smoothed; 0 at rest. */
  get speed(): number {
    return this.speedPxPerS;
  }

  /** The list scrolled. */
  start(): void {
    this.scrolling = true;
  }

  /**
   * The reader moved the list to `top` (px) at `at` (ms on the `performance.now()` clock).
   * Watchers hear the new speed.
   */
  moved(top: number, at: number): void {
    const last = this.last;
    this.last = { top, at };
    const elapsed = last ? at - last.at : 0;
    if (!last || elapsed <= 0 || elapsed > SAMPLE_GAP_MS) {
      this.speedPxPerS = 0;
    } else {
      const instant = (Math.abs(top - last.top) / elapsed) * 1000;
      const weight = Math.min(1, elapsed / SPEED_SMOOTHING_MS);
      this.speedPxPerS += (instant - this.speedPxPerS) * weight;
    }
    this.notify();
  }

  /** The list itself just moved the scroll position by `delta` px: not the reader's doing. */
  shifted(delta: number): void {
    if (this.last) this.last = { ...this.last, top: this.last.top + delta };
  }

  /** Forget the estimate: the list now shows another room. */
  reset(): void {
    this.speedPxPerS = 0;
    this.last = null;
  }

  /** The scroll has been still for the idle window: run the hover it held back. */
  settle(): void {
    this.scrolling = false;
    this.speedPxPerS = 0;
    this.last = null;
    const run = this.deferred;
    this.deferred = null;
    run?.();
    this.notify();
  }

  /** Hold `run` until the scroll settles, replacing any row that held the pointer before. */
  defer(run: () => void): void {
    this.deferred = run;
  }

  /** Drop `run` if it is still waiting: its row lost the pointer before the scroll settled. */
  cancel(run: () => void): void {
    if (this.deferred === run) {
      this.deferred = null;
    }
  }

  /** Call `listener` after every movement and when the scroll settles; returns the unsubscribe. */
  watch(listener: () => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }

  private notify(): void {
    for (const listener of this.watchers) listener();
  }
}
