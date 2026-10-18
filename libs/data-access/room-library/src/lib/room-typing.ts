import { inject, signal } from '@angular/core';
import {
  type MatrixClient,
  type MatrixEvent,
  type RoomMember,
} from 'matrix-js-sdk';
import {
  coalesce,
  MatrixClientService,
} from '@trinity/data-access/matrix-client';

const EMPTY_TYPING: readonly string[] = Object.freeze([]);

/** Whether two typing-name lists say the same thing, in order. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * Who is typing in every joined Room, for {@link RoomLibraryService}. The service owns this
 * instance, binds its handlers to the projected client and resets it with the projection.
 */
export class RoomTyping {
  private readonly matrix = inject(MatrixClientService);

  private readonly _typingByRoom = signal<Record<string, readonly string[]>>(
    {},
  );

  private readonly dirtyTypingRooms = new Map<string, string[]>();

  /**
   * Coalesced, and separate from the Room-list projection: adding `RoomMemberEvent.Typing` to
   * its `events` would run a full rebuild and re-sort on every typing EDU from every room, where
   * this writes one key.
   */
  private readonly typingFlusher = coalesce(() => {
    const rooms = [...this.dirtyTypingRooms];
    this.dirtyTypingRooms.clear();
    const client = this.client();
    if (!client) {
      return;
    }
    // EVERY signed-in account, not just the active one. A room both accounts are joined to
    // renders as ONE row (see `RoomSummary.accountIds`), so filtering only the active mxid let
    // the user's other account announce itself on their own room.
    const selves = new Set(this.matrix.accountIds());
    let next = this._typingByRoom();
    let changed = false;

    for (const [roomId, typingIds] of rooms) {
      const room = client.getRoom(roomId);
      // The ids come off the EDU the handler already received, so this is O(typists).
      // `getMembers()` — what TimelineService does — is O(members), which is fine for the
      // one open room and not for every joined room on every typing change.
      const names = typingIds
        .filter((userId) => !selves.has(userId))
        .map((userId) => room?.getMember(userId)?.name ?? userId);
      const current = next[roomId] ?? EMPTY_TYPING;
      // Idempotent: an unchanged set writes nothing. Without this every EDU replaces the
      // record and re-runs the sidebar template, which reads this during change detection.
      if (sameNames(current, names)) {
        continue;
      }
      if (!changed) {
        next = { ...next };
        changed = true;
      }
      if (names.length) {
        next[roomId] = names;
      } else {
        delete next[roomId];
      }
    }

    if (changed) {
      this._typingByRoom.set(next);
    }
  });

  /**
   * Who is typing, per room, excluding the local user: the sidebar's source. Client-level, so
   * it sees every room; `TimelineService` tracks only the open one.
   */
  readonly typingByRoom = this._typingByRoom.asReadonly();

  /**
   * Our OWN membership changed. The rebuild is already covered by `RoomEvent.MyMembership` in
   * the projection's event list; this clears transient typing state for a Room we left. Room
   * Administration owns rosters.
   */
  readonly onMyMembership = (room?: { roomId?: string }): void => {
    // A room we have left stops syncing, so its members never emit "stopped typing" and its key
    // would sit in the map for the session, reappearing frozen on rejoin because an unchanged
    // set writes nothing.
    const roomId = room?.roomId;
    if (roomId) {
      this.dirtyTypingRooms.delete(roomId);
      const current = this._typingByRoom();
      if (roomId in current) {
        const next = { ...current };
        delete next[roomId];
        this._typingByRoom.set(next);
      }
    }
  };

  /**
   * A member started or stopped typing. The event names the member, not the set, so the
   * room's whole typing set is re-read on flush.
   */
  readonly onTypingChanged = (event: MatrixEvent, member: RoomMember): void => {
    // `m.typing` carries the room's WHOLE typing set, so the last event per room wins and
    // there is no delta to merge. Taking it here rather than re-reading members on flush
    // keeps the cost O(typists) instead of O(members-in-every-joined-room).
    const userIds = event.getContent()?.['user_ids'];
    this.dirtyTypingRooms.set(
      member.roomId,
      Array.isArray(userIds) ? (userIds as string[]) : [],
    );
    this.typingFlusher.schedule();
  };

  /** @param client The client the Room-list projection is attached to, or null. */
  constructor(private readonly client: () => MatrixClient | null) {}

  /** Drop every typing state and any scheduled flush. */
  reset(): void {
    // The typing flusher reads `projection.client()` and returns when there is none, so a
    // late flush cannot repopulate from the outgoing client. Cancelling also skips that
    // microtask, and reset owns every scheduled task this service creates.
    this.typingFlusher.cancel();
    this.dirtyTypingRooms.clear();
    this._typingByRoom.set({});
  }
}
