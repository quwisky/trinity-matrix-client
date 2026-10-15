import { ErrorHandler, Injectable, Injector, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  ClientEvent,
  SyncState,
  type SyncStateData,
  type Room,
} from 'matrix-js-sdk';
import {
  EMPTY,
  Observable,
  defer,
  ignoreElements,
  merge,
  switchMap,
} from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ConversationRuntime } from './conversation-runtime.service';
import {
  TRIM_HIGH_WATER,
  noteSyncPosition,
  trimLiveTimeline,
} from './live-timeline-trim';

/**
 * Keeps the rooms of every live Account bounded while they receive events nobody reads.
 *
 * The SDK appends each event `/sync` delivers to the room's live timeline and only drops
 * them on a gappy sync or a restart, so a busy room left in the tray grows for as long as
 * the app runs. After each sync this records where the sync left every room, which is
 * the only place a live event can later be cut from, and trims a room that has passed
 * {@link TRIM_HIGH_WATER} events back to its latest ones, unless a Conversation handle
 * holds it: a focused or retained room is trimmed when its handle retires instead.
 *
 * Not bounded: the focused room. The release after the window has been hidden for a
 * minute retires only the retained handles and keeps the focused conversation on screen,
 * so a room left open in a hidden window keeps every event it receives until the person
 * moves to another room and its handle retires, or the app restarts.
 */
@Injectable({ providedIn: 'root' })
export class LiveTimelineTrimmer {
  private readonly injector = inject(Injector);
  private readonly matrix = inject(MatrixClientService);
  private readonly conversations = inject(ConversationRuntime);
  private readonly errors = inject(ErrorHandler);

  /** Owned by the Application Runtime session; detaches every listener on unsubscribe. */
  run(): Observable<never> {
    return toObservable(this.matrix.accountIds, {
      injector: this.injector,
    }).pipe(
      switchMap((ids) => merge(...ids.map((id) => this.bound(id)))),
      ignoreElements(),
    );
  }

  private bound(accountId: string): Observable<never> {
    return defer(() => {
      const client = this.matrix.clientFor(accountId);
      if (!client) return EMPTY;
      return new Observable<never>(() => {
        // A room that failed once is reported once, not on every later sync.
        const failed = new WeakSet<Room>();
        const onSync = (
          state: SyncState,
          _previous: SyncState | null,
          data?: SyncStateData,
        ): void => {
          const token = data?.nextSyncToken;
          if (
            !token ||
            (state !== SyncState.Syncing && state !== SyncState.Prepared)
          ) {
            return;
          }
          for (const room of client.getRooms()) {
            if (failed.has(room)) continue;
            try {
              noteSyncPosition(room, token);
              if (
                room.getLiveTimeline().getEvents().length > TRIM_HIGH_WATER &&
                !this.conversations.holds(accountId, room.roomId)
              ) {
                trimLiveTimeline(room, accountId);
              }
            } catch (error: unknown) {
              // Never into the SDK's sync loop: the room just keeps its events.
              failed.add(room);
              this.errors.handleError(error);
            }
          }
        };
        client.on(ClientEvent.Sync, onSync);
        return () => client.off(ClientEvent.Sync, onSync);
      });
    });
  }
}
