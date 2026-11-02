import { signal } from '@angular/core';

/** How close to the old position a settled scroll must land to count as undone by the scroll view. */
const UNDONE_WITHIN_PX = 8;

/** How long after a write's own scroll event it can be undone: the scroll view does it within a few frames. */
const UNDONE_WITHIN_MS = 300;

/**
 * iOS scrolls this list in a native scroll view that owns the position during a touch and through
 * momentum: a `scrollTop` written then is overwritten within a few frames, unless it lies past the
 * old scrollable end (why a room's first page of history survives and later ones do not). WebKit
 * gives no signal for it, and a list corrected that way loses the reader's place.
 *
 * So while the scroll view owns the position, a correction is held instead of written: the content
 * is pulled back by a negative margin the same size, which leaves the scroll view's content and
 * position alone. It is written once nothing has moved for the idle window and no finger is down.
 * Until then older rows stay out of reach, and the reader's own rows do not move.
 */
export class NativeScrollHold {
  private touches = 0;
  /** A correction the scroll view may yet undo: where the list stood before it, and after. */
  private written: {
    readonly from: number;
    readonly to: number;
    readonly at: number;
  } | null = null;
  /** The scroll view undid a write: wait for the reader to move before trying again. */
  private refused = false;

  /** Pixels held back: how much further down the content the reader really is than `scrollTop`. */
  readonly shift = signal(0);

  constructor(private readonly enabled: boolean) {}

  /** The touches now on screen, from a touch event's own count. */
  touched(count: number): void {
    this.touches = count;
    this.refused = false;
  }

  /** Whether a write now would be overwritten, given whether the list scrolled within the idle window. */
  ownedByScrollView(scrolling: boolean): boolean {
    return this.enabled && (this.touches > 0 || scrolling);
  }

  /** Whether the held shift can be written now. A scroll that has gone idle no longer owns it. */
  canSettle(): boolean {
    return this.shift() !== 0 && this.touches === 0 && !this.refused;
  }

  /** Stop holding. Returns the pixels to write. */
  settle(): number {
    const shift = this.shift();
    this.shift.set(0);
    return shift;
  }

  /** Note a correction just written, so {@link scrolled} can tell if the scroll view undoes it. */
  wrote(from: number, to: number, at: number): void {
    if (this.enabled && Math.abs(to - from) > UNDONE_WITHIN_PX * 2) {
      this.written = { from, to, at };
    }
  }

  /** The list is about to go somewhere itself: arriving back at the old position is not an undo. */
  forgetWrite(): void {
    this.written = null;
  }

  /**
   * A scroll event. A touch that catches a fling reaches the page as no touch event at all, so a
   * write can still land under a finger, and a few frames later the scroll view puts the old
   * position back. Returns true when it did, with the correction held again.
   */
  scrolled(scrollTop: number, now: number): boolean {
    const written = this.written;
    if (written && Math.abs(scrollTop - written.to) < 1) {
      // The event for the write itself; it can still be undone. A stall can delay this and the
      // undo alike, so the time runs from here.
      this.written = { ...written, at: now };
      return false;
    }
    this.written = null;
    if (
      written &&
      now - written.at <= UNDONE_WITHIN_MS &&
      Math.abs(scrollTop - written.from) < UNDONE_WITHIN_PX
    ) {
      this.shift.update((shift) => shift + written.to - scrollTop);
      this.refused = true;
      return true;
    }
    this.refused = false;
    return false;
  }

  /** Forget everything: another room. */
  reset(): void {
    this.touches = 0;
    this.written = null;
    this.refused = false;
    this.shift.set(0);
  }
}
