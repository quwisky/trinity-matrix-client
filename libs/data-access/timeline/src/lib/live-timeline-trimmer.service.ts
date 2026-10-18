import { ErrorHandler, Injectable, Injector, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  ClientEvent,
  EventType,
  KnownMembership,
  SyncState,
  type EventTimeline,
  type MatrixClient,
  type MatrixEvent,
  type SyncStateData,
  type Room,
} from 'matrix-js-sdk';
import {
  EMPTY,
  Observable,
  Subscription,
  concatWith,
  defer,
  finalize,
  ignoreElements,
  merge,
  switchMap,
} from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ConversationRuntime } from './conversation-runtime.service';
import {
  TRIM_HIGH_WATER,
  noteSyncPosition,
  rewindLiveTimeline,
  trimLiveTimeline,
} from './live-timeline-trim';
import { scrollbackLive } from './live-scrollback';
import {
  decrypted,
  heldEventIds,
  holdUnreadCounts,
} from './rewind-unread-hold';

/** The page a rewound room nobody has open gets back, so its room-list preview is not blank. */
const REFILL_PAGE = 30;

/**
 * Keeps the rooms of every live Account bounded while they receive events nobody reads.
 *
 * The SDK appends each event `/sync` delivers to the room's live timeline and only drops
 * them on a gappy sync or a restart, so a busy room left in the tray grows for as long as
 * the app runs. After each sync this records where the sync left every room, which is
 * the only place a live event can later be cut from, and trims a room that has passed
 * {@link TRIM_HIGH_WATER} events back to its latest ones. A room a Conversation handle
 * holds is left to {@link ConversationRuntime.trimHeld}: a retained room is trimmed when
 * its handle retires, and the focused room only while the window is hidden and its view
 * follows the newest message, keeping what that view shows. That room is tried as
 * soon as the window has been hidden a while, then after each sync. If its trim fails it
 * is reported once and not tried again while open; once nobody has it open, it is trimmed
 * like any other room.
 *
 * It also rewinds rooms after the person unblocks someone; see {@link rewind}.
 *
 * Not bounded: a focused room scrolled back, or whose composer replies to or edits an
 * event, keeps what it holds from there on while the window is hidden, until the person
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

  /**
   * Rewind every room a Conversation handle holds or one of `userIds` is known to be in,
   * and page it back in, so it shows their messages. Thread replies stay as they were
   * until the thread is opened again. A member the room has not lazily loaded is missed.
   * Unread counts stay as they were, plus the hidden messages that are unread.
   */
  private rewind(
    client: MatrixClient,
    accountId: string,
    userIds: readonly string[],
    syncToken: string,
    refills: Subscription,
  ): void {
    for (const room of client.getRooms()) {
      // Only a joined room can be paged: the server refuses an invite or a room left.
      if (room.getMyMembership() !== KnownMembership.Join) continue;
      const held = this.conversations.holds(accountId, room.roomId);
      if (!held && !userIds.some((userId) => room.getMember(userId))) continue;
      try {
        const depth = room.getLiveTimeline().getEvents().length;
        const counted = heldEventIds(room);
        rewindLiveTimeline(room, syncToken);
        const release = holdUnreadCounts(client, room, counted);
        const refill = held
          ? this.conversations.refillHeld(accountId, room.roomId, depth)
          : defer(() => scrollbackLive(client, room, REFILL_PAGE));
        refills.add(
          refill
            .pipe(concatWith(defer(() => decrypted(room))), finalize(release))
            .subscribe({
              error: (error: unknown) => this.errors.handleError(error),
            }),
        );
      } catch (error: unknown) {
        this.errors.handleError(error);
      }
    }
  }

  private bound(accountId: string): Observable<never> {
    return defer(() => {
      const client = this.matrix.clientFor(accountId);
      if (!client) return EMPTY;
      return new Observable<never>(() => {
        // A room that failed once is reported once, not on every later sync.
        const failed = new WeakSet<Room>();
        // Likewise an open room whose hidden-window trim failed: it is not tried again
        // while open, but it is still trimmed like any other once nobody has it open.
        const failedOpen = new WeakSet<Room>();
        const trimHeld = (room: Room): void => {
          if (
            failedOpen.has(room) ||
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
        // What each live timeline looked like when last examined. A sync that brought a
        // room nothing new leaves it as it was, so a room that could not be trimmed is not
        // scanned again until it receives an event. A trim or a gappy sync replaces the
        // timeline, which starts unseen.
        const seen = new WeakMap<EventTimeline, TimelineMark>();
        // The server leaves a blocked person's events out of every sync and page, and an
        // unblock brings back none of them. Rooms they may have written in are rewound at the
        // first sync after the server echoed the unblock, so they page back in complete.
        const unblocked = new Set<string>();
        const onAccountData = (event: MatrixEvent, previous?: MatrixEvent) => {
          if (event.getType() !== EventType.IgnoredUserList || !previous)
            return;
          const now = ignoredIn(event);
          for (const userId of ignoredIn(previous)) {
            if (!now.has(userId)) unblocked.add(userId);
          }
        };
        const refills = new Subscription();
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
          if (unblocked.size > 0) {
            this.rewind(client, accountId, [...unblocked], token, refills);
            unblocked.clear();
          }
          for (const room of client.getRooms()) {
            if (failed.has(room)) continue;
            try {
              const timeline = room.getLiveTimeline();
              if (sameAs(seen.get(timeline), timeline)) continue;
              noteSyncPosition(room, token);
              if (!this.conversations.holds(accountId, room.roomId)) {
                if (timeline.getEvents().length > TRIM_HIGH_WATER) {
                  trimLiveTimeline(room, accountId);
                }
              } else {
                trimHeld(room);
              }
              const now = room.getLiveTimeline();
              seen.set(now, markOf(now));
            } catch (error: unknown) {
              // Never into the SDK's sync loop: the room just keeps its events.
              failed.add(room);
              this.errors.handleError(error);
            }
          }
        };
        client.on(ClientEvent.AccountData, onAccountData);
        client.on(ClientEvent.Sync, onSync);
        // The window has just been hidden for a while: trim the open room now rather than
        // at its next event, which may be hours away.
        const hidden = toObservable(this.conversations.windowHidden, {
          injector: this.injector,
        }).subscribe((isHidden) => {
          const key = this.conversations.focused()?.key;
          const room =
            isHidden && key?.accountId === accountId
              ? client.getRoom(key.roomId)
              : null;
          if (room) trimHeld(room);
        });
        return () => {
          client.off(ClientEvent.AccountData, onAccountData);
          client.off(ClientEvent.Sync, onSync);
          hidden.unsubscribe();
          refills.unsubscribe();
        };
      });
    });
  }
}

function ignoredIn(event: MatrixEvent): Set<string> {
  const users: unknown = event.getContent()['ignored_users'];
  return new Set(users && typeof users === 'object' ? Object.keys(users) : []);
}

/** How many events a live timeline held and which came last. */
interface TimelineMark {
  readonly length: number;
  readonly lastEventId: string | undefined;
}

function markOf(timeline: EventTimeline): TimelineMark {
  const events = timeline.getEvents();
  return { length: events.length, lastEventId: events.at(-1)?.getId() };
}

function sameAs(
  mark: TimelineMark | undefined,
  timeline: EventTimeline,
): boolean {
  if (!mark) return false;
  const now = markOf(timeline);
  return now.length === mark.length && now.lastEventId === mark.lastEventId;
}
