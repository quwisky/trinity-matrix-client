import { Injectable, inject } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { HostLifecycleService } from '@trinity/runtime/host';
import { EMPTY, Observable, ignoreElements, tap } from 'rxjs';

/**
 * Stops every account's sync while the app is in a phone's background, where the system would
 * freeze it anyway and push wakes it, and restarts it on the way back. Hosts that keep the app
 * running in the background (web, desktop) keep syncing.
 */
@Injectable({ providedIn: 'root' })
export class BackgroundSync {
  private readonly lifecycle = inject(HostLifecycleService);
  private readonly matrix = inject(MatrixClientService);

  run(): Observable<never> {
    if (!this.lifecycle.suspendedInBackground) return EMPTY;
    return this.lifecycle.events.pipe(
      tap((event) =>
        event.kind === 'background'
          ? this.matrix.suspendSync()
          : this.matrix.resumeSync(),
      ),
      ignoreElements(),
    );
  }
}
