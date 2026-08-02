import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { startOfLocalDay, startOfNextLocalDay } from '@trinity/util-matrix';

/**
 * The local calendar day the user is currently in, as a signal — so anything deriving
 * "Today"/"Yesterday" re-derives when the day actually turns over, rather than whenever the
 * next message happens to arrive. A room left open overnight would otherwise keep calling
 * yesterday's messages "Today" until something else invalidated the timeline.
 *
 * One timer, armed for the next local midnight and re-armed on each fire, so the cost is a
 * single wake-up per day however many rooms are open. Under zoneless change detection the
 * signal write *is* the notification: it marks its consumers dirty and the scheduler picks
 * them up, so nothing here needs NgZone or ApplicationRef.
 *
 * The timer alone is not enough. `setTimeout` deadlines are measured against a monotonic
 * clock that does not advance while a device is suspended, so a phone asleep at midnight
 * resumes with the timer still pending for the un-elapsed remainder — up to nearly a full
 * day of calling yesterday "Today". Foregrounding therefore re-derives from the wall clock
 * as well.
 */
@Injectable({ providedIn: 'root' })
export class DayBoundaryService {
  private readonly _todayStart = signal(startOfLocalDay(Date.now()));

  /** Epoch ms of the local midnight that started today. */
  readonly todayStart = this._todayStart.asReadonly();

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.arm();

    // Guarded for the non-DOM contexts the rest of the workspace guards for (SSR, unit
    // code outside a browser environment).
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
   * Re-read the wall clock and restart the timer. Called on foregrounding, where both halves
   * matter: the published day may be stale, *and* the pending timer's deadline may be hours
   * behind the wall clock after a suspend, so it is replaced rather than left to fire late.
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
   * recomputed from `Date.now()` on every fire rather than carried forward, so a throttled
   * tab and a timezone change both land on the correct day instead of accumulating drift.
   * The delay is at most ~25h, well under the ~24.9 days that would overflow `setTimeout`.
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
