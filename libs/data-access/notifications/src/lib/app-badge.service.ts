import {
  DestroyRef,
  ErrorHandler,
  Injectable,
  effect,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { UnreadAggregatorService } from '@trinity/data-access/rooms';
import { HostBadgeService } from '@trinity/runtime/host';
import { EMPTY, Subject, catchError, switchMap } from 'rxjs';

/**
 * Mirrors the app-wide unread total ({@link UnreadAggregatorService.totalUnread},
 * summed across every signed-in account) onto whatever app-icon badge the current
 * host supports. Product code knows only the badge operation; Web, Capacitor, and
 * Electron selection belongs to the application composition root. Newer totals cancel
 * stale in-flight writes via `switchMap`. Instantiated as a root service at startup (an app
 * initializer in `apps/trinity/src/main.ts`) so its effect stays live for the
 * whole session.
 */
@Injectable({ providedIn: 'root' })
export class AppBadgeService {
  private readonly unread = inject(UnreadAggregatorService);
  private readonly badge = inject(HostBadgeService);
  private readonly errorHandler = inject(ErrorHandler);
  private readonly destroyRef = inject(DestroyRef);
  private readonly totals = new Subject<number>();

  constructor() {
    this.totals
      .pipe(
        switchMap((total) =>
          this.badge.set(total).pipe(
            catchError((error: unknown) => {
              this.errorHandler.handleError(error);
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
    effect(() => this.totals.next(this.unread.totalUnread()));
  }
}
