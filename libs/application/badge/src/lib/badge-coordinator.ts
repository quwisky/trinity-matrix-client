import { Injectable, Injector, effect, inject } from '@angular/core';
import { UnreadAggregatorService } from '@trinity/data-access/room-library';
import type { HostOperationOutcome } from '@trinity/runtime/host';
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
      const unreadEffect = effect(
        () => totals.next(this.unread.totalUnread()),
        { injector: this.injector },
      );
      return () => {
        unreadEffect.destroy();
        writes.unsubscribe();
        totals.complete();
      };
    });
  }
}
