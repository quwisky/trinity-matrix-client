import { Injectable } from '@angular/core';

/**
 * Whether the timeline is mid-scroll, shared by the message list with its rows.
 *
 * A scroll slides a new row under a still pointer almost every frame. Each of those rows
 * used to mount its hover toolbar and arm its time tooltip, a style recalculation and
 * layout per frame for rows the reader is only passing (#1288). While the list scrolls, a
 * row the pointer enters defers that work here instead. Only the latest row is kept, since
 * only one row can hold the pointer, and it runs once the scroll settles.
 *
 * Plain fields, not signals: nothing renders from this state, so scroll events must not
 * schedule change detection through it.
 */
@Injectable()
export class TimelineScrollActivity {
  private scrolling = false;
  private deferred: (() => void) | null = null;

  /** Whether the list has scrolled within its idle window. */
  get active(): boolean {
    return this.scrolling;
  }

  /** The list scrolled. */
  start(): void {
    this.scrolling = true;
  }

  /** The scroll has been still for the idle window: run the hover it held back. */
  settle(): void {
    this.scrolling = false;
    const run = this.deferred;
    this.deferred = null;
    run?.();
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
}
