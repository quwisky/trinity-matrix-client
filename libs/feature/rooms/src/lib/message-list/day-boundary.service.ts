import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { startOfLocalDay, startOfNextLocalDay } from '@trinity/util/matrix';

/**
 * The local calendar day the user is in, as a signal, so "Today"/"Yesterday" re-derive when the
 * day turns over rather than when the next message arrives.
 *
 * One timer, armed for the next local midnight and re-armed on each fire: a single wake-up per day
 * however many rooms are open. Under zoneless change
 * detection the signal write *is* the notification, so nothing here needs NgZone or ApplicationRef.
 *
 * The timer alone is not enough: `setTimeout` uses a monotonic clock that does not advance while
 * a device is suspended, so a phone asleep at midnight resumes with the timer still pending for up
 * to nearly a day. Foregrounding therefore re-derives from the wall clock as well.
 */
@Injectable({ providedIn: 'root' })
export class DayBoundaryService {
  private readonly _todayStart = signal(startOfLocalDay(Date.now()));

  /** Epoch ms of the local midnight that started today. */
  readonly todayStart = this._todayStart.asReadonly();

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.arm();

    // Guarded for non-DOM contexts (SSR, unit code outside a browser).
    const doc = typeof document !== 'undefined' ? document : null;
    const onVisibility = () => {
      if (doc?.visibilityState === 'visible') {
        this.refresh();
      }
    };
    doc?.addEventListener('visibilitychange', onVisibility);

    inject(DestroyRef).onDestroy(() => {
      doc?.removeEventListener('visibilitychange', onVisibility);
      this.disarm();
    });
  }

  /**
   * Re-read the wall clock and restart the timer (on foregrounding). Both halves matter: the
   * published day may be stale, and after a suspend the pending timer may be hours behind the
   * wall clock, so it is replaced rather than left to fire late.
   */
  private refresh(): void {
    this.disarm();
    this._todayStart.set(startOfLocalDay(Date.now()));
    this.arm();
  }

  private disarm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Sleep until the next local midnight, then republish the day and re-arm. The target is
   * recomputed from `Date.now()` on every fire, so a throttled tab or timezone change lands on
   * the correct day without drift. The delay is at most ~25h, under the ~24.9 days that overflow `setTimeout`.
   */
  private arm(): void {
    const now = Date.now();
    this.timer = setTimeout(
      () => {
        this._todayStart.set(startOfLocalDay(Date.now()));
        this.arm();
      },
      Math.max(1, startOfNextLocalDay(now) - now),
    );
  }
}
