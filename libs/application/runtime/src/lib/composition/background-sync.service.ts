import { Injectable, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { PushService } from '@trinity/data-access/notifications';
import {
  BackgroundActivityService,
  HostLifecycleService,
} from '@trinity/runtime/host';
import {
  EMPTY,
  Observable,
  defer,
  filter,
  ignoreElements,
  of,
  switchMap,
  take,
  tap,
} from 'rxjs';

/**
 * Stops every account's sync while the app is in a phone's background, where the system would
 * freeze it anyway and push wakes it, and restarts it on the way back. Hosts that keep the app
 * running in the background (web, desktop) keep syncing, and so does Android until push
 * delivers there, since its sync is then what notifies. A running call keeps sync going until
 * it ends, since the call is what holds the process alive.
 */
@Injectable({ providedIn: 'root' })
export class BackgroundSync {
  private readonly lifecycle = inject(HostLifecycleService);
  private readonly matrix = inject(MatrixClientService);
  private readonly push = inject(PushService);
  private readonly activity = inject(BackgroundActivityService);
  private readonly active$ = toObservable(this.activity.active);

  run(): Observable<never> {
    if (!this.lifecycle.suspendedInBackground) return EMPTY;
    return this.lifecycle.events.pipe(
      // A return to the foreground drops a suspension still waiting on the call.
      switchMap((event) => {
        if (event.kind === 'active') {
          this.matrix.resumeSync();
          return EMPTY;
        }
        // Asked at each departure: push may have come or gone since the last one.
        if (this.push.notifiesFromBackgroundSync()) return EMPTY;
        return this.activityEnded().pipe(tap(() => this.matrix.suspendSync()));
      }),
      ignoreElements(),
    );
  }

  private activityEnded(): Observable<unknown> {
    return defer(() =>
      this.activity.active()
        ? this.active$.pipe(
            filter((active) => !active),
            take(1),
          )
        : of(true),
    );
  }
}
