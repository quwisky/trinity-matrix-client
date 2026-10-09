import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  ClientEvent,
  MatrixEventEvent,
  NotificationCountType,
  RoomEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import {
  coalesce,
  MatrixClientService,
} from '@trinity/data-access/matrix-client';
import { roomAvatarMxc } from '@trinity/util/matrix';
import { directMapOf, initialOf, isMarkedUnread } from './room-projection';

/** A no-arg listener reused across every unread-affecting client / room event. */
type UnreadListener = () => void;

/** The client + shared handler attached for one account, kept so we can detach it. */
interface AccountListener {
  readonly client: MatrixClient;
  readonly handler: UnreadListener;
}

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
  /** `room.getLastActiveTimestamp()`. */
  readonly activityTs: number;
}

/**
 * Cross-account unread aggregator. Where {@link RoomLibraryService.totalUnread} sums only the
 * ACTIVE account's rooms, this sums every signed-in account so the app-icon badge — and,
 * later, the account switcher — reflects all of them at once.
 *
 * It attaches a lightweight listener to each account's client (reading notification
 * counts directly, with no full room projection) and reconciles that listener set as
 * accounts are added or removed. Recomputes are coalesced onto a microtask so a sync
 * burst across several accounts rebuilds the totals once; the rebuild writes a signal,
 * which schedules change detection so the badge updates promptly.
 *
 * The same pass also publishes the per-room list ({@link unreadRooms}) for the space rail.
 */
@Injectable({ providedIn: 'root' })
export class UnreadAggregatorService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _unreadByAccount = signal<ReadonlyMap<string, number>>(
    new Map(),
  );
  /** Unread notification total per account user id (absent = not yet synced). */
  readonly unreadByAccount = this._unreadByAccount.asReadonly();

  /** App-wide unread total across every signed-in account. Drives the app-icon badge. */
  readonly totalUnread = computed(() => {
    let sum = 0;
    for (const count of this._unreadByAccount().values()) {
      sum += count;
    }
    return sum;
  });

  private readonly _unreadRooms = signal<readonly UnreadRoom[]>([], {
    equal: sameUnreadRooms,
  });
  /**
   * Every unread chat on every signed-in account, under the app badge's rule: joined, not a
   * space, and a notification count or the marked-unread flag. A muted room's push rules
   * keep its count at zero, so it is listed only while marked unread. The same room on two
   * accounts is two entries.
   */
  readonly unreadRooms = this._unreadRooms.asReadonly();

  private readonly listeners = new Map<string, AccountListener>();

  constructor() {
    // Reconcile per-account listeners against the live account set — runs at startup
    // and on every add/remove, attaching to new clients and dropping gone ones.
    effect(() => this.reconcile(this.matrix.accountIds()));
  }

  private reconcile(ids: readonly string[]): void {
    const live = new Set(ids);
    for (const [userId, listener] of this.listeners) {
      if (!live.has(userId)) {
        this.detach(listener.client, listener.handler);
        this.listeners.delete(userId);
      }
    }
    for (const userId of ids) {
      const client = this.matrix.clientFor(userId);
      const held = this.listeners.get(userId);
      if (held) {
        // Same user id can get a NEW client object (re-adding an already signed-in account
        // stops and re-creates it). Holding the old one strands the listener on a stopped
        // client and that account silently stops updating.
        if (held.client === client) {
          continue;
        }
        this.detach(held.client, held.handler);
        this.listeners.delete(userId);
      }
      if (!client) {
        continue; // not fully started yet; a later accountIds tick re-checks it
      }
      const handler: UnreadListener = () => this.scheduleFlush();
      this.attach(client, handler);
      this.listeners.set(userId, { client, handler });
    }
    this.scheduleFlush();
  }

  /**
   * Coalesce a burst of events into one rebuild: recompute the totals on the microtask
   * after the current task drains, deduped by the shared coalescer.
   */
  /**
   * Coalesced through the shared primitive. Keyed on the account set, not one active
   * client, so it takes the batching alone rather than `projectFromClient`.
   */
  private readonly flusher = coalesce(() => {
    // flush() writes the per-account signal, which schedules change detection.
    this.flush();
  });

  private scheduleFlush(): void {
    this.flusher.schedule();
  }

  private flush(): void {
    const counts = new Map<string, number>();
    const rooms: UnreadRoom[] = [];
    for (const userId of this.listeners.keys()) {
      const unread = this.unreadRoomsFor(userId);
      // A room flagged to come back to counts as one although the server's count for it is
      // zero: that flag is the only thing saying it wants attention, and a badge that ignored
      // it would leave "come back to this" visible nowhere but the sidebar row.
      counts.set(
        userId,
        unread.reduce((sum, room) => sum + (room.unreadCount || 1), 0),
      );
      rooms.push(...unread);
    }
    this._unreadByAccount.set(counts);
    this._unreadRooms.set(rooms);
  }

  /**
   * An account's joined, non-space rooms that want attention: a notification count above
   * zero, or the marked-unread flag even when the count is zero.
   */
  private unreadRoomsFor(userId: string): UnreadRoom[] {
    const client = this.matrix.clientFor(userId);
    if (!client) {
      return [];
    }
    let direct: ReturnType<typeof directMapOf> | null = null;
    const unread: UnreadRoom[] = [];
    for (const room of client.getRooms()) {
      if (room.isSpaceRoom() || room.getMyMembership() !== 'join') {
        continue;
      }
      const unreadCount =
        room.getUnreadNotificationCount(NotificationCountType.Total) ?? 0;
      const markedUnread = isMarkedUnread(room);
      if (unreadCount <= 0 && !markedUnread) {
        continue;
      }
      // Read m.direct only when some room is unread: most syncs touch no unread room at all.
      direct ??= directMapOf(client);
      const isDirect = direct.ids.has(room.roomId);
      const name = room.name || room.roomId;
      unread.push({
        accountId: userId,
        roomId: room.roomId,
        name,
        initial: initialOf(name),
        avatarMxc: roomAvatarMxc(room, isDirect),
        direct: isDirect,
        unreadCount,
        markedUnread,
        activityTs: room.getLastActiveTimestamp(),
      });
    }
    return unread;
  }

  private attach(client: MatrixClient, handler: UnreadListener): void {
    client.on(ClientEvent.Sync, handler);
    client.on(ClientEvent.Room, handler);
    client.on(RoomEvent.MyMembership, handler);
    client.on(RoomEvent.Receipt, handler);
    client.on(RoomEvent.AccountData, handler); // carries the marked-unread flag
    // Encrypted rooms count a message only once it decrypts, after its Sync; the
    // client re-emits Decrypted then. Without it the badge waits for the next sync.
    client.on(MatrixEventEvent.Decrypted, handler);
  }

  private detach(client: MatrixClient, handler: UnreadListener): void {
    client.off(ClientEvent.Sync, handler);
    client.off(ClientEvent.Room, handler);
    client.off(RoomEvent.MyMembership, handler);
    client.off(RoomEvent.Receipt, handler);
    client.off(RoomEvent.AccountData, handler);
    client.off(MatrixEventEvent.Decrypted, handler);
  }
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
