import { Injectable, inject, type Signal } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ActiveAccountProjectionLifetime } from '@trinity/runtime/projection';
import { isTransientMatrixError } from '@trinity/util/matrix';
import { Observable, catchError, throwError } from 'rxjs';
import { RoomNotificationsService } from './room-notifications.service';

/** Value-safe failure from preparing the per-Room notification projection. */
export class NotificationLifetimeError extends Error {
  override readonly name = 'NotificationLifetimeError';

  constructor() {
    super('Per-Room notification settings are temporarily unavailable.');
  }
}

/** Per-Room notification state retained for one Application Runtime session. */
@Injectable({ providedIn: 'root' })
export class NotificationLifetime {
  private readonly lifetime = inject(ActiveAccountProjectionLifetime);
  private readonly matrix = inject(MatrixClientService);
  private readonly roomNotifications = inject(RoomNotificationsService);

  /** Attach on routed Room demand and release with the owning Runtime session. */
  run(demanded: Signal<boolean>): Observable<void> {
    return this.lifetime
      .run({
        activeAccountId: this.matrix.activeUserId,
        demanded,
        connect: () => this.roomNotifications.connect(),
        disconnect: () => this.roomNotifications.disconnect(),
      })
      .pipe(
        catchError((error: unknown) =>
          throwError(() =>
            isTransientMatrixError(error)
              ? new NotificationLifetimeError()
              : error,
          ),
        ),
      );
  }
}
