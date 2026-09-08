import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import { UnreadAggregatorService } from '@trinity/data-access/room-library';
import type { HostOperationOutcome } from '@trinity/runtime/host';
import { HostLifecycleService } from '@trinity/runtime/host';
import { Observable, Subject, catchError, of, switchMap } from 'rxjs';
import { BADGE_SINK } from './badge-sink';

/**
 * Aggregates Room Library unread state and mirrors it to exactly one host sink.
 * Conversation read-position changes remain Conversation-owned; their authoritative
 * receipt updates flow into Room Library's aggregate without a dependency from Badge.
 */
@Injectable({ providedIn: 'root' })
export class BadgeCoordinator {
  private readonly unread = inject(UnreadAggregatorService);
  private readonly sink = inject(BADGE_SINK);
  private readonly injector = inject(Injector);
  private readonly lifecycle = inject(HostLifecycleService);

  /** Application Runtime owns this cold stream for one restartable session. */
  run(): Observable<HostOperationOutcome> {
    return new Observable((subscriber) => {
      const totals = new Subject<number>();
      const writes = totals
        .pipe(
          switchMap((total) =>
            this.sink.write(total).pipe(
              catchError(() =>
                of({
                  kind: 'rejected',
                  diagnostic: { code: 'badge-sink-failed' },
                } as const),
              ),
            ),
          ),
        )
        .subscribe(subscriber);
      const lifecycleEvents = this.lifecycle.events.subscribe((event) => {
        if (event.kind === 'active') {
          untracked(() => totals.next(this.unread.totalUnread()));
        }
      });
      const unreadEffect = effect(
        () => {
          // Track reconciliation generations even when the aggregate is unchanged;
          // this restores the Matrix total after a native background snapshot.
          this.unread.unreadByAccount();
          const total = untracked(() => this.unread.totalUnread());
          // Synchronous sink outcomes must not add their consumers' health
          // signals to the unread effect and feed writes back into themselves.
          untracked(() => totals.next(total));
        },
        { injector: this.injector },
      );
      return () => {
        unreadEffect.destroy();
        lifecycleEvents.unsubscribe();
        writes.unsubscribe();
        totals.complete();
      };
    });
  }
}
