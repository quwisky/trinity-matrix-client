import { Injectable, inject } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { PushService } from '@trinity/data-access/notifications';
import { HostLifecycleService } from '@trinity/runtime/host';
import { EMPTY, Observable, ignoreElements, tap } from 'rxjs';

/**
 * Stops every account's sync while the app is in a phone's background, where the system would
 * freeze it anyway and push wakes it, and restarts it on the way back. Hosts that keep the app
 * running in the background (web, desktop) keep syncing, and so does Android until push
 * delivers there, since its sync is then what notifies.
 */
@Injectable({ providedIn: 'root' })
export class BackgroundSync {
  private readonly lifecycle = inject(HostLifecycleService);
  private readonly matrix = inject(MatrixClientService);
  private readonly push = inject(PushService);

  run(): Observable<never> {
    if (!this.lifecycle.suspendedInBackground) return EMPTY;
    return this.lifecycle.events.pipe(
      tap((event) => {
        if (event.kind === 'active') this.matrix.resumeSync();
        // Asked at each departure: push may have come or gone since the last one.
        else if (!this.push.notifiesFromBackgroundSync())
          this.matrix.suspendSync();
      }),
      ignoreElements(),
    );
  }
}
