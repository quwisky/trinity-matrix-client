import { Injectable, computed, inject } from '@angular/core';
import { RoomListStore } from './room-list-store';
import { initialOf } from './room-projection';

/** One joined chat with something new in it, on one exact account. */
export interface UnreadRoom {
  readonly accountId: string;
  readonly roomId: string;
  readonly name: string;
  readonly initial: string;
  readonly avatarMxc: string | null;
  readonly direct: boolean;
  /** Total notification count; 0 when the room is only marked unread. */
  readonly unreadCount: number;
  readonly markedUnread: boolean;
  /** The main timeline's last event or a newer thread reply. */
  readonly activityTs: number;
}

/**
 * Cross-account unread aggregator: where {@link RoomLibraryService.totalUnread} sums only the
 * ACTIVE account's rooms, this sums every signed-in account (app-icon badge), folding each
 * live account's {@link RoomListStore} rows.
 */
@Injectable({ providedIn: 'root' })
export class UnreadAggregatorService {
  private readonly store = inject(RoomListStore);

  /**
   * Every unread chat on every signed-in account, under the app badge's rule: joined, not a
   * space, and a notification count or the marked-unread flag. A muted room's push rules
   * keep its count at zero, so it is listed only while marked unread. The same room on two
   * accounts is two entries.
   */
  readonly unreadRooms = computed<readonly UnreadRoom[]>(
    () =>
      this.store.liveAccountIds().flatMap((accountId) =>
        this.store
          .rooms(accountId)()
          .filter(
            (info) =>
              info.membership === 'join' &&
              !info.isSpace &&
              (info.notificationCount > 0 || info.markedUnread),
          )
          .map((info): UnreadRoom => ({
            accountId,
            roomId: info.roomId,
            name: info.displayName,
            initial: initialOf(info.displayName),
            avatarMxc: info.avatarMxc,
            direct: info.directUserId !== null,
            unreadCount: info.notificationCount,
            markedUnread: info.markedUnread,
            activityTs: info.recencyStamp,
          })),
      ),
    { equal: sameUnreadRooms },
  );

  /**
   * Unread notification total per live account user id. Equal by content: every sync
   * rebuilds the map, and an unchanged one must not ripple through every badge that reads it.
   */
  readonly unreadByAccount = computed<ReadonlyMap<string, number>>(
    () => {
      const counts = new Map(
        this.store.liveAccountIds().map((accountId) => [accountId, 0]),
      );
      for (const room of this.unreadRooms()) {
        // A room flagged to come back to counts as one although the server's count is zero:
        // the flag is the only sign it wants attention, and ignoring it would leave it
        // visible only in the sidebar row.
        counts.set(
          room.accountId,
          (counts.get(room.accountId) ?? 0) + (room.unreadCount || 1),
        );
      }
      return counts;
    },
    { equal: sameCounts },
  );

  /** App-wide unread total across every signed-in account. Drives the app-icon badge. */
  readonly totalUnread = computed(() => {
    let sum = 0;
    for (const count of this.unreadByAccount().values()) {
      sum += count;
    }
    return sum;
  });
}

/** Same accounts with the same counts. */
function sameCounts(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

function sameUnreadRooms(
  a: readonly UnreadRoom[],
  b: readonly UnreadRoom[],
): boolean {
  return (
    a.length === b.length && a.every((room, i) => sameUnreadRoom(room, b[i]))
  );
}

function sameUnreadRoom(a: UnreadRoom, b: UnreadRoom): boolean {
  return (
    a.accountId === b.accountId &&
    a.roomId === b.roomId &&
    a.name === b.name &&
    a.avatarMxc === b.avatarMxc &&
    a.direct === b.direct &&
    a.unreadCount === b.unreadCount &&
    a.markedUnread === b.markedUnread &&
    a.activityTs === b.activityTs
  );
}
