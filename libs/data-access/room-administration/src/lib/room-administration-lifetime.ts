import { Injectable, inject, type Signal } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ActiveAccountProjectionLifetime } from '@trinity/runtime/projection';
import { isTransientMatrixError } from '@trinity/util/matrix';
import { Observable, catchError, combineLatest, map, throwError } from 'rxjs';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import { RoomMembersService } from './room-members.service';

const ROOM_ADMINISTRATION_PROJECTION_IDS = [
  'room-administration.action-permissions',
  'room-administration.members',
] as const;

/** Value-safe failure from preparing Room Administration projections. */
export class RoomAdministrationLifetimeError extends Error {
  override readonly name = 'RoomAdministrationLifetimeError';

  constructor() {
    super('Room permissions and member summaries are temporarily unavailable.');
  }
}

/** Room Administration projections retained for one Application Runtime session. */
@Injectable({ providedIn: 'root' })
export class RoomAdministrationLifetime {
  private readonly lifetime = inject(ActiveAccountProjectionLifetime);
  private readonly matrix = inject(MatrixClientService);
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly members = inject(RoomMembersService);

  /** Attach on routed Room demand and release with the owning Runtime session. */
  run(demanded: Signal<boolean>): Observable<void> {
    return this.lifetime
      .run({
        activeAccountId: this.matrix.activeUserId,
        demanded,
        projectionIds: ROOM_ADMINISTRATION_PROJECTION_IDS,
        runProjection: () =>
          combineLatest([
            this.permissions.runProjection(),
            this.members.runProjection(),
          ]).pipe(map(() => void 0)),
      })
      .pipe(
        catchError((error: unknown) =>
          throwError(() =>
            isTransientMatrixError(error)
              ? new RoomAdministrationLifetimeError()
              : error,
          ),
        ),
      );
  }
}
