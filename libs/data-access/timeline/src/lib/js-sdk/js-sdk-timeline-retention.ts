import type { ErrorHandler } from '@angular/core';
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
  type Observable,
  Subscription,
  catchError,
  concatWith,
  defer,
  finalize,
} from 'rxjs';
import type { RetentionHint } from '../timeline-engine';
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

export interface RetentionPorts {
  readonly clientFor: (accountId: string) => MatrixClient | null;
  readonly errors: ErrorHandler;
  /** Whether an open `timeline()` subscription shows the room. */
  readonly subscribed: (client: MatrixClient, roomId: string) => boolean;
  /**
   * Pages a rewound room back in to about `target` items, stopping once `held` turns false.
   * Cold; errors when a page fails.
   */
  readonly refill: (
    accountId: string,
    roomId: string,
    target: number,
    held: () => boolean,
  ) => Observable<unknown>;
}

/** One account's sync loop on the client of one session generation. */
interface Loop {
  readonly generation: number;
  readonly client: MatrixClient;
  /** A room whose trim failed: reported once, not tried on every later sync. */
  readonly failed: WeakSet<Room>;
  /** A held room whose trim failed: not tried again while held, trimmed once released. */
  readonly failedHeld: WeakSet<Room>;
  readonly stop: () => void;
}

/**
 * Keeps the rooms of every live account bounded while they receive events nobody reads,
 * by the {@link RetentionHint}s the rooms' holders send.
 *
 * The SDK appends each event `/sync` delivers to the room's live timeline and only drops
 * them on a gappy sync or a restart, so a busy room left in the tray grows for as long as
 * the app runs. After each sync this records where the sync left every room, which is
 * the only place a live event can later be cut from, and trims a room that has passed
 * {@link TRIM_HIGH_WATER} events back to its latest ones. A held room (one with a hint, or
 * one an open `timeline()` shows, until its hint arrives) is trimmed only while its hint
 * says the window is hidden and its view follows the newest message, keeping what the hint
 * names. If that trim fails it is reported once and not tried again while held; once
 * released, the room is trimmed like any other.
 *
 * It also rewinds rooms after the person unblocks someone; see {@link rewind}.
 */
export class JsSdkTimelineRetention {
  private readonly hints = new Map<string, Map<string, RetentionHint>>();
  private readonly loops = new Map<string, Loop>();

  constructor(private readonly ports: RetentionPorts) {}

  /** Binds a loop to each live account's client and drops the loops of every other. */
  follow(
    accounts: readonly {
      readonly accountId: string;
      readonly generation: number;
    }[],
  ): void {
    const live = new Map(accounts.map((a) => [a.accountId, a.generation]));
    for (const [accountId, loop] of [...this.loops]) {
      if (live.get(accountId) === loop.generation) continue;
      this.loops.delete(accountId);
      loop.stop();
    }
    for (const accountId of [...this.hints.keys()]) {
      if (!live.has(accountId)) this.hints.delete(accountId);
    }
    for (const [accountId, generation] of live) {
      if (this.loops.has(accountId)) continue;
      const client = this.ports.clientFor(accountId);
      if (client) {
        this.loops.set(accountId, this.bind(client, accountId, generation));
      }
    }
  }

  /**
   * Records the room's hint and trims it now if the hint allows: a released room past the
   * high-water mark, or a held one the window hides at its newest message. Returns the
   * client when it trimmed.
   */
  setHint(
    accountId: string,
    roomId: string,
    hint: RetentionHint | null,
  ): MatrixClient | null {
    const rooms = this.hints.get(accountId) ?? new Map<string, RetentionHint>();
    if (hint) rooms.set(roomId, hint);
    else rooms.delete(roomId);
    if (rooms.size > 0) this.hints.set(accountId, rooms);
    else this.hints.delete(accountId);
    const loop = this.loops.get(accountId);
    const room = loop?.client.getRoom(roomId);
    if (!loop || !room) return null;
    const before = room.getLiveTimeline();
    try {
      if (hint) {
        this.trimHeld(loop, accountId, room, hint);
      } else if (
        !this.ports.subscribed(loop.client, roomId) &&
        before.getEvents().length > TRIM_HIGH_WATER
      ) {
        trimLiveTimeline(room, accountId);
      }
    } catch (error: unknown) {
      this.ports.errors.handleError(error);
    }
    return room.getLiveTimeline() === before ? null : loop.client;
  }

  private hintOf(accountId: string, roomId: string): RetentionHint | null {
    return this.hints.get(accountId)?.get(roomId) ?? null;
  }

  private held(
    client: MatrixClient,
    accountId: string,
    roomId: string,
  ): boolean {
    return (
      !!this.hintOf(accountId, roomId) || this.ports.subscribed(client, roomId)
    );
  }

  private trimHeld(
    loop: Loop,
    accountId: string,
    room: Room,
    hint: RetentionHint,
  ): void {
    if (
      !hint.windowHidden ||
      !hint.followingLive ||
      loop.failedHeld.has(room) ||
      room.getLiveTimeline().getEvents().length <= TRIM_HIGH_WATER
    ) {
      return;
    }
    try {
      trimLiveTimeline(room, accountId, {
        kept: hint.kept,
        marked: hint.marked,
      });
    } catch (error: unknown) {
      loop.failedHeld.add(room);
      this.ports.errors.handleError(error);
    }
  }

  /**
   * Rewind every room that is held or one of `userIds` is known to be in, and page it back
   * in, so it shows their messages. Thread replies stay as they were until the thread is
   * opened again. A member the room has not lazily loaded is missed. Unread counts stay as
   * they were, plus the hidden messages that are unread.
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
      const held = this.held(client, accountId, room.roomId);
      if (!held && !userIds.some((userId) => room.getMember(userId))) continue;
      try {
        const depth = room.getLiveTimeline().getEvents().length;
        const counted = heldEventIds(room);
        rewindLiveTimeline(room, syncToken);
        const release = holdUnreadCounts(client, room, counted);
        // A shown room pages back to about its depth, at least one page; any other one page.
        const target =
          this.hintOf(accountId, room.roomId)?.shown === false ? 1 : depth;
        const refill = held
          ? this.ports.refill(accountId, room.roomId, target, () =>
              this.held(client, accountId, room.roomId),
            )
          : defer(() => scrollbackLive(client, room, REFILL_PAGE));
        refills.add(
          refill
            .pipe(
              // A failed page still waits for the pages before it to decrypt.
              catchError((error: unknown) => {
                this.ports.errors.handleError(error);
                return EMPTY;
              }),
              concatWith(defer(() => decrypted(room))),
              finalize(release),
            )
            .subscribe(),
        );
      } catch (error: unknown) {
        this.ports.errors.handleError(error);
      }
    }
  }

  private bind(
    client: MatrixClient,
    accountId: string,
    generation: number,
  ): Loop {
    // What each live timeline looked like when last examined. A sync that brought a
    // room nothing new leaves it as it was, so a room that could not be trimmed is not
    // scanned again until it receives an event. A trim or a gappy sync replaces the
    // timeline, which starts unseen.
    const seen = new WeakMap<EventTimeline, TimelineMark>();
    // The server leaves a blocked person's events out of every sync and page, and an
    // unblock brings back none of them. Rooms they may have written in are rewound at the
    // first sync after the server echoed the unblock, so they page back in complete.
    const unblocked = new Set<string>();
    const refills = new Subscription();
    const onAccountData = (event: MatrixEvent, previous?: MatrixEvent) => {
      if (event.getType() !== EventType.IgnoredUserList || !previous) return;
      const now = ignoredIn(event);
      for (const userId of ignoredIn(previous)) {
        if (!now.has(userId)) unblocked.add(userId);
      }
    };
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
        if (loop.failed.has(room)) continue;
        try {
          const timeline = room.getLiveTimeline();
          if (sameAs(seen.get(timeline), timeline)) continue;
          noteSyncPosition(room, token);
          const hint = this.hintOf(accountId, room.roomId);
          if (hint) {
            this.trimHeld(loop, accountId, room, hint);
          } else if (
            !this.ports.subscribed(client, room.roomId) &&
            timeline.getEvents().length > TRIM_HIGH_WATER
          ) {
            trimLiveTimeline(room, accountId);
          }
          const now = room.getLiveTimeline();
          seen.set(now, markOf(now));
        } catch (error: unknown) {
          // Never into the SDK's sync loop: the room just keeps its events.
          loop.failed.add(room);
          this.ports.errors.handleError(error);
        }
      }
    };
    client.on(ClientEvent.AccountData, onAccountData);
    client.on(ClientEvent.Sync, onSync);
    const loop: Loop = {
      generation,
      client,
      failed: new WeakSet<Room>(),
      failedHeld: new WeakSet<Room>(),
      stop: () => {
        client.off(ClientEvent.AccountData, onAccountData);
        client.off(ClientEvent.Sync, onSync);
        refills.unsubscribe();
      },
    };
    return loop;
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
