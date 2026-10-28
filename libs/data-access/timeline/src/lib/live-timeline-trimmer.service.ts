import { ErrorHandler, Injectable, Injector, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  ClientEvent,
  SyncState,
  type Room,
  type SyncStateData,
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
import { TRIM_HIGH_WATER } from './js-sdk/live-timeline-trim';

/**
 * Trims the focused room through {@link ConversationRuntime.trimHeld} while the window is
 * hidden: as soon as the window has been hidden a while, then after each sync. If its trim
 * fails it is reported once and not tried again while open.
 *
 * Every other trim, and the rewind after an unblock, runs in the js-sdk timeline engine,
 * which leaves a room an open timeline shows to that room's retention hint.
 */
@Injectable({ providedIn: 'root' })
export class LiveTimelineTrimmer {
  private readonly injector = inject(Injector);
  private readonly matrix = inject(MatrixClientService);
  private readonly conversations = inject(ConversationRuntime);
  private readonly errors = inject(ErrorHandler);
  // One observer for every run and account, not one per subscription.
  private readonly windowHidden = toObservable(this.conversations.windowHidden);

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
        const failedOpen = new WeakSet<Room>();
        const trimHeld = (room: Room): void => {
          if (
            failedOpen.has(room) ||
            !this.conversations.holds(accountId, room.roomId) ||
            room.getLiveTimeline().getEvents().length <= TRIM_HIGH_WATER
          ) {
            return;
          }
          try {
            this.conversations.trimHeld(accountId, room.roomId);
          } catch (error: unknown) {
            failedOpen.add(room);
            this.errors.handleError(error);
          }
        };
        // Only the focused room is trimmed while held.
        const trimFocused = (): void => {
          const key = this.conversations.focused()?.key;
          const room =
            key?.accountId === accountId ? client.getRoom(key.roomId) : null;
          if (room) trimHeld(room);
        };
        const onSync = (
          state: SyncState,
          _previous: SyncState | null,
          data?: SyncStateData,
        ): void => {
          if (
            data?.nextSyncToken &&
            (state === SyncState.Syncing || state === SyncState.Prepared)
          ) {
            trimFocused();
          }
        };
        client.on(ClientEvent.Sync, onSync);
        // The window has just been hidden for a while: trim the open room now rather than
        // at its next event, which may be hours away.
        const hidden = this.windowHidden.subscribe((isHidden) => {
          if (isHidden) trimFocused();
        });
        return () => {
          client.off(ClientEvent.Sync, onSync);
          hidden.unsubscribe();
        };
      });
    });
  }
}
