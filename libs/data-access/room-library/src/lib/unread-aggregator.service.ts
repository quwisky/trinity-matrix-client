import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  ClientEvent,
  EventType,
  MatrixEventEvent,
  NotificationCountType,
  RoomEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type SyncState,
} from 'matrix-js-sdk';
import {
  coalesce,
  MatrixClientService,
} from '@trinity/data-access/matrix-client';
import { roomAvatarMxc } from '@trinity/util/matrix';
import {
  directMapOf,
  initialOf,
  isMarkedUnread,
  roomActivityTs,
} from './room-projection';
import { FULL_REFRESH_MS, roomIdOf } from './room-event-target';

/** A listener attached to one account's client. */
type UnreadListener = (...args: unknown[]) => void;

/** The client and the handlers attached for one account, kept so we can detach them. */
interface AccountListener {
  readonly client: MatrixClient;
  /** A room event: recount that room. */
  readonly onRoom: UnreadListener;
  /** A room joined or left the list: recount everything. */
  readonly onList: UnreadListener;
  /** A sync landed: compare counts, then flush what changed. */
  readonly onSync: (state: SyncState, prev: SyncState | null) => void;
  /** Global account data: `m.direct` changes every room's DM flag and avatar. */
  readonly onAccountData: (event?: MatrixEvent) => void;
}

/**
 * One account's unread rooms and what has changed since the last flush (#1311). A flush
 * recounts only the rooms an event touched; every other room's entry stands. Before, every
 * flush walked every joined room of every account, on every sync.
 */
interface AccountUnread {
  /** Rooms that want attention, by room id. */
  readonly cache: Map<string, UnreadRoom>;
  /**
   * Every room's count when it was last counted, listed or not. A sync re-marks a room only
   * when its count moved, so a space or a left room that keeps a count is not recounted on
   * every sync.
   */
  readonly seen: Map<string, number>;
  readonly dirty: Set<string>;
  /** Recount every room on the next flush. */
  full: boolean;
  /** A sync landed since the last flush: compare every room's count with its entry. */
  compare: boolean;
  lastFull: number;
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

  // Equal by content: every sync rebuilds the map, and an unchanged one must not ripple
  // through every badge that reads it (#1292).
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
  private readonly accounts = new Map<string, AccountUnread>();

  constructor() {
    // Reconcile per-account listeners against the live account set — runs at startup
    // and on every add/remove, attaching to new clients and dropping gone ones.
    effect(() => this.reconcile(this.matrix.accountIds()));
  }

  private reconcile(ids: readonly string[]): void {
    const live = new Set(ids);
    for (const [userId, listener] of this.listeners) {
      if (!live.has(userId)) {
        this.detach(listener);
        this.listeners.delete(userId);
        this.accounts.delete(userId);
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
        this.detach(held);
        this.listeners.delete(userId);
      }
      if (!client) {
        continue; // not fully started yet; a later accountIds tick re-checks it
      }
      const state = this.stateFor(userId);
      state.full = true; // a new client: count every room once
      const listener: AccountListener = {
        client,
        onRoom: (...args) => {
          const roomId = roomIdOf(args);
          if (roomId) {
            state.dirty.add(roomId);
          } else {
            state.full = true;
          }
          this.scheduleFlush();
        },
        onList: () => {
          state.full = true;
          this.scheduleFlush();
        },
        onSync: (syncState, prev) => {
          // A changed sync state (prepared, or caught up after a reconnect) can bring many
          // rooms' changes at once: recount them all.
          if (syncState !== prev) {
            state.full = true;
          } else {
            state.compare = true;
          }
          this.scheduleFlush();
        },
        onAccountData: (event) => {
          if (event?.getType?.() === EventType.Direct) {
            state.full = true;
            this.scheduleFlush();
          }
        },
      };
      this.attach(listener);
      this.listeners.set(userId, listener);
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

  private stateFor(userId: string): AccountUnread {
    let state = this.accounts.get(userId);
    if (!state) {
      state = {
        cache: new Map(),
        seen: new Map(),
        dirty: new Set(),
        full: true,
        compare: false,
        lastFull: 0,
      };
      this.accounts.set(userId, state);
    }
    return state;
  }

  private flush(): void {
    const counts = new Map<string, number>();
    const rooms: UnreadRoom[] = [];
    const now = Date.now();
    for (const [userId, { client }] of this.listeners) {
      const state = this.stateFor(userId);
      if (state.full || now - state.lastFull >= FULL_REFRESH_MS) {
        state.cache.clear();
        state.seen.clear();
        for (const room of this.unreadRoomsFor(userId, client, state.seen)) {
          state.cache.set(room.roomId, room);
        }
        state.full = false;
        state.compare = false;
        state.lastFull = now;
        state.dirty.clear();
      } else {
        if (state.compare) {
          state.compare = false;
          markChangedCounts(client, state);
        }
        if (state.dirty.size) {
          this.recountTouched(userId, client, state);
        }
      }
      // A room flagged to come back to counts as one although the server's count for it is
      // zero: that flag is the only thing saying it wants attention, and a badge that ignored
      // it would leave "come back to this" visible nowhere but the sidebar row.
      let total = 0;
      for (const room of state.cache.values()) {
        total += room.unreadCount || 1;
        rooms.push(room);
      }
      counts.set(userId, total);
    }
    this._unreadByAccount.set(counts);
    this._unreadRooms.set(rooms);
  }

  /** Recount just the rooms an event touched, keeping every other room's entry. */
  private recountTouched(
    userId: string,
    client: MatrixClient,
    state: AccountUnread,
  ): void {
    const touched = [...state.dirty];
    state.dirty.clear();
    let direct: ReturnType<typeof directMapOf> | null = null;
    for (const roomId of touched) {
      const room = client.getRoom(roomId);
      let entry: UnreadRoom | null = null;
      if (room) {
        const count = countOf(room);
        state.seen.set(roomId, count);
        entry = this.unreadRoomOf(
          userId,
          room,
          count,
          () => (direct ??= directMapOf(client)),
        );
      } else {
        state.seen.delete(roomId);
      }
      if (entry) {
        state.cache.set(roomId, entry);
      } else {
        state.cache.delete(roomId);
      }
    }
  }

  /**
   * An account's joined, non-space rooms that want attention: a notification count above
   * zero, or the marked-unread flag even when the count is zero.
   */
  private unreadRoomsFor(
    userId: string,
    client: MatrixClient,
    seen: Map<string, number>,
  ): UnreadRoom[] {
    let direct: ReturnType<typeof directMapOf> | null = null;
    const unread: UnreadRoom[] = [];
    for (const room of client.getRooms()) {
      const count = countOf(room);
      seen.set(room.roomId, count);
      // Read m.direct only when some room is unread: most syncs touch no unread room at all.
      const entry = this.unreadRoomOf(
        userId,
        room,
        count,
        () => (direct ??= directMapOf(client)),
      );
      if (entry) unread.push(entry);
    }
    return unread;
  }

  /** One room's entry, or null when it is not a joined chat that wants attention. */
  private unreadRoomOf(
    userId: string,
    room: Room,
    unreadCount: number,
    directMap: () => ReturnType<typeof directMapOf>,
  ): UnreadRoom | null {
    if (room.isSpaceRoom() || room.getMyMembership() !== 'join') {
      return null;
    }
    const markedUnread = isMarkedUnread(room);
    if (unreadCount <= 0 && !markedUnread) {
      return null;
    }
    const isDirect = directMap().ids.has(room.roomId);
    const name = room.name || room.roomId;
    return {
      accountId: userId,
      roomId: room.roomId,
      name,
      initial: initialOf(name),
      avatarMxc: roomAvatarMxc(room, isDirect),
      direct: isDirect,
      unreadCount,
      markedUnread,
      activityTs: roomActivityTs(room),
    };
  }

  private attach({
    client,
    onRoom,
    onList,
    onSync,
    onAccountData,
  }: AccountListener): void {
    client.on(ClientEvent.Sync, onSync);
    client.on(ClientEvent.AccountData, onAccountData);
    client.on(ClientEvent.Room, onList);
    client.on(RoomEvent.MyMembership, onList);
    // A new message raises a room's count; a receipt clears it.
    client.on(RoomEvent.Timeline, onRoom);
    client.on(RoomEvent.Receipt, onRoom);
    client.on(RoomEvent.AccountData, onRoom); // carries the marked-unread flag
    // Encrypted rooms count a message only once it decrypts, after its Sync; the
    // client re-emits Decrypted then. Without it the badge waits for the next sync.
    client.on(MatrixEventEvent.Decrypted, onRoom);
    // The rail draws the room's name, and its activity time moves when a local echo is
    // replaced by the server's copy.
    client.on(RoomEvent.Name, onRoom);
    client.on(RoomEvent.LocalEchoUpdated, onRoom);
  }

  private detach({
    client,
    onRoom,
    onList,
    onSync,
    onAccountData,
  }: AccountListener): void {
    client.off(ClientEvent.Sync, onSync);
    client.off(ClientEvent.AccountData, onAccountData);
    client.off(ClientEvent.Room, onList);
    client.off(RoomEvent.MyMembership, onList);
    client.off(RoomEvent.Timeline, onRoom);
    client.off(RoomEvent.Receipt, onRoom);
    client.off(RoomEvent.AccountData, onRoom);
    client.off(MatrixEventEvent.Decrypted, onRoom);
    client.off(RoomEvent.Name, onRoom);
    client.off(RoomEvent.LocalEchoUpdated, onRoom);
  }
}

function countOf(room: Room): number {
  return room.getUnreadNotificationCount(NotificationCountType.Total) ?? 0;
}

/**
 * Mark every room whose count moved since it was last counted. A sync can change a count
 * with no event this service hears: one carrying only the counts, or the SDK's start-up
 * fix-up (`fixupRoomNotifications`), which zeroes rooms whose last message is your own. The
 * SDK announces these with `RoomEvent.UnreadNotifications`, but only on the room, not the
 * client. Reading one count per room is cheap next to building every entry.
 */
function markChangedCounts(client: MatrixClient, state: AccountUnread): void {
  for (const room of client.getRooms()) {
    if (state.seen.get(room.roomId) !== countOf(room)) {
      state.dirty.add(room.roomId);
    }
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

/**
 * The same entries in any order: a full recount lists rooms in the client's order, while a
 * touched room keeps its place or joins the end. The rail sorts them itself.
 */
function sameUnreadRooms(
  a: readonly UnreadRoom[],
  b: readonly UnreadRoom[],
): boolean {
  if (a.length !== b.length) return false;
  const byKey = new Map(b.map((room) => [unreadKey(room), room]));
  return a.every((room) => {
    const other = byKey.get(unreadKey(room));
    return other !== undefined && sameUnreadRoom(room, other);
  });
}

function unreadKey(room: UnreadRoom): string {
  return `${room.accountId}\n${room.roomId}`;
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
