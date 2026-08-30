import { Injectable, Injector, effect, inject } from '@angular/core';
import { UnreadAggregatorService } from '@trinity/data-access/rooms';
import {
  HostBadgeService,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import { Observable, Subject, switchMap } from 'rxjs';

/**
 * Mirrors the app-wide unread total ({@link UnreadAggregatorService.totalUnread},
 * summed across every signed-in account) onto whatever app-icon badge the current
 * host supports. Product code knows only the badge operation; Web, Capacitor, and
 * Electron selection belongs to the application composition root. Newer totals cancel
 * stale in-flight writes via `switchMap`. Application Runtime owns {@link run}, so both
 * the signal effect and host writes stop at application shutdown and restart cleanly.
 */
@Injectable({ providedIn: 'root' })
export class AppBadgeService {
  private readonly unread = inject(UnreadAggregatorService);
  private readonly badge = inject(HostBadgeService);
  private readonly injector = inject(Injector);

  /** Application Runtime owns this stream and its signal effect for one session. */
  run(): Observable<HostOperationOutcome> {
    return new Observable((subscriber) => {
      const totals = new Subject<number>();
      const writes = totals
        .pipe(switchMap((total) => this.badge.set(total)))
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
