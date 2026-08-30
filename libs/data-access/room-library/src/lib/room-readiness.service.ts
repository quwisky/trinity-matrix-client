import { Injectable, inject } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ClientEvent, SyncState } from 'matrix-js-sdk';
import {
  Observable,
  TimeoutError,
  catchError,
  defer,
  of,
  throwError,
  timeout,
} from 'rxjs';

export const ROOM_READINESS_TIMEOUT_MS = 15_000;

export type RoomReadinessFailure =
  'account-unavailable' | 'sync-stopped' | 'timed-out';

/** Safe operational failure metadata for a finite Room readiness barrier. */
export class RoomReadinessError extends Error {
  override readonly name = 'RoomReadinessError';

  constructor(readonly failure: RoomReadinessFailure) {
    super(`Room readiness failed: ${failure}`);
  }
}

/** Finite readiness barriers for post-write Room Library navigation. */
@Injectable({ providedIn: 'root' })
export class RoomReadinessService {
  private readonly matrix = inject(MatrixClientService);

  /**
   * Wait until one exact Room is present in its Account's synced SDK graph.
   *
   * Successful create/join endpoints can resolve before `/sync` publishes the Room. A
   * Workspace command must not focus that Room until Timeline can attach to the same live
   * object. The listener is installed before the second read to close the
   * event-between-checks race, and cancellation always detaches it. Cold and finite.
   */
  waitForRoom(accountId: string, roomId: string): Observable<void> {
    return defer(() => {
      const client = this.matrix.clientFor(accountId);
      if (!client) {
        return throwError(() => new RoomReadinessError('account-unavailable'));
      }
      if (client.getRoom(roomId)) {
        return of(void 0);
      }
      return new Observable<void>((subscriber) => {
        const onRoom = (): void => {
          if (!client.getRoom(roomId)) return;
          subscriber.next();
          subscriber.complete();
        };
        const onSync = (state: SyncState): void => {
          if (state === SyncState.Stopped) {
            subscriber.error(new RoomReadinessError('sync-stopped'));
          }
        };
        client.on(ClientEvent.Room, onRoom);
        client.on(ClientEvent.Sync, onSync);
        onRoom();
        return () => {
          client.off(ClientEvent.Room, onRoom);
          client.off(ClientEvent.Sync, onSync);
        };
      }).pipe(
        timeout({ first: ROOM_READINESS_TIMEOUT_MS }),
        catchError((error: unknown) =>
          error instanceof TimeoutError
            ? throwError(() => new RoomReadinessError('timed-out'))
            : throwError(() => error),
        ),
      );
    });
  }
}
