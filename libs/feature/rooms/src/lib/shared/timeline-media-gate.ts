import { DestroyRef, Injectable, inject } from '@angular/core';
import { TimelineScrollActivity } from './timeline-scroll-activity';

/**
 * Faster than anyone reads: about two viewports a second. A fling moves 3,000–10,000 px/s,
 * so its images wait; a reader scrolling to read keeps loading them as they come near.
 */
const READING_SPEED_PX_PER_S = 1_500;

/** How far beyond the list's viewport a row counts as near: half its height above and below. */
const NEAR_MARGIN = '50% 0px';

interface Waiting {
  readonly start: () => void;
  /** Whether the row was last reported within {@link NEAR_MARGIN} of the viewport. */
  near: boolean;
}

/**
 * Holds timeline image loads back while the list moves faster than anyone reads, behind the
 * "Load images after fast scrolling" flag (Settings › Experimental).
 *
 * A fast scroll mounts and destroys about a hundred rows a second, and every image among them
 * used to be fetched, decoded and uploaded to the GPU as its row mounted, only to be thrown
 * away a moment later. With the gate on, a row's image starts only when the row is near the
 * viewport and the list is still or moving at reading speed ({@link TimelineScrollActivity}).
 * A row that leaves before then never loads, and when a fling settles only the rows still near
 * the viewport start, not every row it passed.
 *
 * Off, it starts every load at once, as the timeline always has. One per message list,
 * shared by its rows; a row rendered outside a list has no gate and loads at once too.
 */
@Injectable()
export class TimelineMediaGate {
  private readonly activity = inject(TimelineScrollActivity);
  private isEnabled = false;
  private connected = false;
  private observer: IntersectionObserver | null = null;
  private readonly waiting = new Map<Element, Waiting>();

  constructor() {
    const unwatch = this.activity.watch(() => this.onScrollChange());
    inject(DestroyRef).onDestroy(() => {
      unwatch();
      this.observer?.disconnect();
      this.waiting.clear();
    });
  }

  /** Whether loads wait for the list ("Load images after fast scrolling" is on). */
  get enabled(): boolean {
    return this.isEnabled;
  }

  /** Turn the gate on or off; turning it off starts every load it still holds. */
  setEnabled(on: boolean): void {
    this.isEnabled = on;
    if (on) return;
    for (const [target, waiting] of [...this.waiting]) {
      this.release(target, waiting);
    }
  }

  /** The list rendered: watch its rows against its own viewport, `root`. */
  connect(root: HTMLElement): void {
    if (this.connected) return;
    this.connected = true;
    if (typeof IntersectionObserver === 'undefined') {
      // Nothing can tell how near a row is: every row counts as near, so only speed holds it.
      for (const waiting of this.waiting.values()) waiting.near = true;
      this.onScrollChange();
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => this.onIntersection(entries),
      { root, rootMargin: NEAR_MARGIN },
    );
    for (const target of this.waiting.keys()) this.observer.observe(target);
  }

  /**
   * Run `start` once `target`'s row may load its image: at once while the gate is off,
   * otherwise when it is near the viewport and the list is not scrolling fast. Returns the
   * cancel, for a row destroyed (or given other media) before then.
   */
  whenReady(target: Element, start: () => void): () => void {
    if (!this.isEnabled) {
      start();
      return () => undefined;
    }
    const waiting: Waiting = {
      start,
      near: this.connected && typeof IntersectionObserver === 'undefined',
    };
    this.waiting.set(target, waiting);
    if (waiting.near && !this.fast()) {
      this.release(target, waiting);
      return () => undefined;
    }
    this.observer?.observe(target);
    return () => {
      if (this.waiting.get(target) !== waiting) return;
      this.waiting.delete(target);
      this.observer?.unobserve(target);
    };
  }

  private onIntersection(entries: readonly IntersectionObserverEntry[]): void {
    const fast = this.fast();
    for (const entry of entries) {
      const waiting = this.waiting.get(entry.target);
      if (!waiting) continue;
      waiting.near = entry.isIntersecting;
      if (waiting.near && !fast) this.release(entry.target, waiting);
    }
  }

  /** The list moved or settled: once it is slow enough, start the rows waiting near view. */
  private onScrollChange(): void {
    if (this.waiting.size === 0 || this.fast()) return;
    for (const [target, waiting] of [...this.waiting]) {
      if (waiting.near) this.release(target, waiting);
    }
  }

  private release(target: Element, waiting: Waiting): void {
    this.waiting.delete(target);
    this.observer?.unobserve(target);
    waiting.start();
  }

  private fast(): boolean {
    return this.activity.speed >= READING_SPEED_PX_PER_S;
  }
}
