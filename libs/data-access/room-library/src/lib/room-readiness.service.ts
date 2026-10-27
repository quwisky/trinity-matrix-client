import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import {
  Observable,
  TimeoutError,
  catchError,
  defer,
  of,
  throwError,
  timeout,
} from 'rxjs';
import { RoomListStore } from './room-list-store';

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
  private readonly store = inject(RoomListStore);
  private readonly session = inject(SessionStateService);
  private readonly injector = inject(Injector);

  /**
   * Wait until one exact Room is in its Account's room list, joined. Cold and finite.
   *
   * Create/join endpoints can resolve before `/sync` publishes the Room, and a Room already
   * listed (invited) keeps that membership until `/sync` brings the join; a Workspace command
   * must not focus it until Timeline can attach to that same live object. The wait is an
   * effect that re-reads the list and session state on every run, so a change between the
   * first check and the first run is not missed; cancellation destroys it.
   */
  waitForRoom(accountId: string, roomId: string): Observable<void> {
    return defer(() => {
      if (!this.session.status(accountId)) {
        return throwError(() => new RoomReadinessError('account-unavailable'));
      }
      const joined = (): boolean =>
        this.store.room(accountId, roomId)?.membership === 'join';
      if (joined()) {
        return of(void 0);
      }
      return new Observable<void>((subscriber) => {
        const watch = effect(
          () => {
            const status = this.session.status(accountId);
            // An account that left the session has stopped syncing as surely as a stopped one.
            if (!status || status.syncState === 'stopped') {
              untracked(() =>
                subscriber.error(new RoomReadinessError('sync-stopped')),
              );
            } else if (joined()) {
              untracked(() => {
                subscriber.next();
                subscriber.complete();
              });
            }
          },
          { injector: this.injector },
        );
        return () => watch.destroy();
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
