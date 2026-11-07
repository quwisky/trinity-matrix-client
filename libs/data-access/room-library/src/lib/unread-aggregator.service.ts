import {
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  ClientEvent,
  MatrixEventEvent,
  NotificationCountType,
  RoomEvent,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import {
  coalesce,
  MatrixClientService,
} from '@trinity/data-access/matrix-client';
import { initialOf, roomAvatarMxc } from '@trinity/util/matrix';
import {
  decryptionChangesRow,
  directMapOf,
  isMarkedUnread,
  roomActivityTs,
} from './room-projection';

/** The client and handlers attached for one account, kept so we can detach them. */
interface AccountListener {
  readonly client: MatrixClient;
  readonly handler: () => void;
  readonly onSync: () => void;
  readonly onDecrypted: (event: MatrixEvent) => void;
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
  /** {@link roomActivityTs}: the main timeline's last event or a newer thread reply. */
  readonly activityTs: number;
}

/**
 * Cross-account unread aggregator: sums every signed-in account's unread counts (app-icon badge). A lightweight
 * listener per account client reads notification counts directly, without a full room
 * projection, and the same pass publishes the per-room {@link unreadRooms} list. Rebuilds are
 * held for up to 100 ms, and run at the end of each account's sync, so one sync rebuilds once.
 * A timer, not an animation frame, so the app badge still updates in a hidden window.
 */
@Injectable({ providedIn: 'root' })
export class UnreadAggregatorService {
  private readonly matrix = inject(MatrixClientService);

  // Equal by content: every sync rebuilds the map, and an unchanged one must not ripple
  // through every badge that reads it.
  private readonly _unreadByAccount = signal<ReadonlyMap<string, number>>(
    new Map(),
    { equal: sameCounts },
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
  /** Each account's last counted unread rooms; only accounts in {@link stale} are recounted. */
  private readonly unreadByUser = new Map<string, UnreadRoom[]>();
  private readonly stale = new Set<string>();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.flusher.cancel());
    // Reconcile per-account listeners against the live account set (startup, add, remove).
    effect(() => this.reconcile(this.matrix.accountIds()));
  }

  private reconcile(ids: readonly string[]): void {
    const live = new Set(ids);
    for (const [userId, listener] of this.listeners) {
      if (!live.has(userId)) {
        this.detach(listener);
        this.listeners.delete(userId);
        this.unreadByUser.delete(userId);
      }
    }
    for (const userId of ids) {
      const client = this.matrix.clientFor(userId);
      const held = this.listeners.get(userId);
      if (held) {
        // Same user id can get a NEW client object (re-adding a signed-in account recreates
        // it); holding the old one strands the listener on a stopped client.
        if (held.client === client) {
          continue;
        }
        this.detach(held);
        this.listeners.delete(userId);
      }
      if (!client) {
        continue; // not fully started yet; a later accountIds tick re-checks it
      }
      const schedule = () => {
        this.stale.add(userId);
        this.flusher.schedule();
      };
      const listener: AccountListener = {
        client,
        handler: schedule,
        onSync: () => {
          schedule();
          this.flusher.flush();
        },
        // Encrypted rooms count a message only once it decrypts, after its Sync; the client
        // re-emits Decrypted then. History decrypting on a scroll-back changes no count.
        onDecrypted: (event) => {
          if (decryptionChangesRow(client, event)) schedule();
        },
      };
      this.attach(listener);
      this.listeners.set(userId, listener);
      this.stale.add(userId);
    }
    this.flusher.schedule();
  }

  /**
   * Coalesced through the shared primitive. Keyed on the account set, not one active client,
   * so it takes the batching alone rather than `projectFromClient`.
   */
  private readonly flusher = coalesce(() => {
    this.flush();
  }, 100);

  private flush(): void {
    const counts = new Map<string, number>();
    const rooms: UnreadRoom[] = [];
    for (const userId of this.listeners.keys()) {
      let unread = this.unreadByUser.get(userId);
      if (!unread || this.stale.has(userId)) {
        unread = this.unreadRoomsFor(userId);
        this.unreadByUser.set(userId, unread);
      }
      // A room flagged to come back to counts as one although the server's count is zero: the
      // flag is the only sign it wants attention, and ignoring it would leave it visible only
      // in the sidebar row.
      counts.set(
        userId,
        unread.reduce((sum, room) => sum + (room.unreadCount || 1), 0),
      );
      rooms.push(...unread);
    }
    this.stale.clear();
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
        activityTs: roomActivityTs(room),
      });
    }
    return unread;
  }

  private attach({
    client,
    handler,
    onSync,
    onDecrypted,
  }: AccountListener): void {
    client.on(ClientEvent.Sync, onSync);
    client.on(ClientEvent.Room, handler);
    client.on(RoomEvent.MyMembership, handler);
    client.on(RoomEvent.Receipt, handler);
    client.on(RoomEvent.AccountData, handler); // carries the marked-unread flag
    client.on(MatrixEventEvent.Decrypted, onDecrypted);
  }

  private detach({
    client,
    handler,
    onSync,
    onDecrypted,
  }: AccountListener): void {
    client.off(ClientEvent.Sync, onSync);
    client.off(ClientEvent.Room, handler);
    client.off(RoomEvent.MyMembership, handler);
    client.off(RoomEvent.Receipt, handler);
    client.off(RoomEvent.AccountData, handler);
    client.off(MatrixEventEvent.Decrypted, onDecrypted);
  }
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
