import { Injectable, computed, inject, signal, untracked } from '@angular/core';
import {
  ClientEvent,
  EventType,
  NotificationCountType,
  MatrixEventEvent,
  Preset,
  ReceiptType,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type RoomMember,
  type RoomState,
} from 'matrix-js-sdk';
import {
  Observable,
  catchError,
  concatMap,
  defer,
  forkJoin,
  from,
  map,
  of,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import {
  coalesce,
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import { PrivacySettingsService } from '@trinity/platform-native';
import {
  isValidUserId,
  roomEncryptionInitialState,
  visibilityOptions,
} from '@trinity/util/matrix';
import {
  buildRoomSummary,
  compareRoomSummaries,
  directMapOf,
  isMarkedUnread,
  roomActivityTs,
} from './room-projection';
import {
  ROOM_LIBRARY_GOVERNANCE_POLICY,
  assertRoomLibraryGovernance,
  type RoomLibraryGovernanceKey,
} from './room-library-governance-policy';

/** Fields a {@link RoomLibraryService.createRoom} call accepts. */
export interface CreateRoomOptions {
  name: string;
  topic?: string;
  /** Public (discoverable + publicly joinable) vs the default invite-only room. */
  isPublic?: boolean;
}

/** Shared active/exact Account implementation for encrypted Room creation. */
function createEncryptedRoom(
  client: MatrixClient,
  options: CreateRoomOptions,
): Observable<string> {
  return from(
    client.createRoom({
      name: options.name.trim(),
      ...(options.topic?.trim() ? { topic: options.topic.trim() } : {}),
      ...visibilityOptions(options.isPublic),
      initial_state: [roomEncryptionInitialState()],
    }),
  ).pipe(map((response) => response.room_id));
}

/** Room Library's authoritative answer for one Account-and-Room selection. */
export type RoomLibrarySelectionAvailability =
  'available' | 'unconfirmed' | 'unavailable';

/** Exact Account-owned organisation preferences projected from a synced Room. */
export interface RoomOrganisationSnapshot {
  readonly favourite: boolean;
  readonly lowPriority: boolean;
}

/** A joinable room shown in the channel sidebar. */
export interface RoomSummary {
  id: string;
  /** The signed-in account this room belongs to (its user id) — for the mixed view. */
  accountId: string;
  /**
   * Every mixed account joined to this room. Usually just `[accountId]`, but a room both
   * mixed accounts are in is shown as ONE row whose unread is the loudest of the two — so
   * idempotent actions (mark read, mute, favourite) must reach all of them, or the badge
   * the merge produced could never be cleared.
   */
  accountIds: readonly string[];
  name: string;
  initial: string;
  avatarMxc: string | null;
  topic: string;
  memberCount: number;
  /** Whether the room has encryption enabled (`m.room.encryption`). */
  encrypted: boolean;
  /** Total unread notifications (drives the unread highlight). */
  unreadCount: number;
  /** Unread mentions/highlights (drives the red badge). */
  highlightCount: number;
  /** Convenience flag: there are unread notifications, or the room is flagged unread. */
  hasUnread: boolean;
  /** The user flagged this room to come back to (`m.marked_unread`, MSC2867). */
  markedUnread: boolean;
  /** Single-line preview of the room's most recent message (`''` when none). */
  lastMessage: string;
  /** Last-activity timestamp (ms), used to order the list by recency. */
  activityTs: number;
  /** Whether the room carries the `m.favourite` tag — favourite to the top of the list. */
  favourite: boolean;
  /**
   * Whether the room carries the `m.lowpriority` tag — sunk to the bottom of the list, into
   * its own group. A room may hold this and `m.favourite` at once; favourite wins.
   */
  lowPriority: boolean;
  /**
   * For a direct message, the other participant's user id (from the `m.direct` map);
   * undefined for a non-DM room. Lets the sidebar show the counterpart's online status.
   */
  directUserId?: string;
}

const EMPTY_TYPING: readonly string[] = Object.freeze([]);

/**
 * Room events re-emitted at the client that change one room's summary: its latest message
 * and activity, receipts and unread state, name, tags and room account data.
 */
const ROOM_EVENTS = [
  RoomEvent.Timeline,
  RoomEvent.Receipt,
  RoomEvent.Name,
  RoomEvent.Tags,
  RoomEvent.AccountData,
  RoomEvent.LocalEchoUpdated,
  RoomEvent.Redaction,
  RoomEvent.TimelineReset,
] as const;

/**
 * A safety net for summary changes the SDK applies without any room event this service
 * hears. Count changes are already caught by comparing counts after each sync, so what is
 * left is rare (a new thread's bundled latest reply, say). A refresh at least this long
 * after the last full rebuild rebuilds everything. Refreshes follow syncs, so on an idle
 * account the real bound is about the long-poll interval (~30 s), not this value.
 */
const FULL_REBUILD_MS = 15_000;

/** The room a client-level room event concerns: a `Room` argument, or an event naming one. */
function roomIdOf(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    if (arg && typeof arg === 'object') {
      const candidate = arg as {
        roomId?: unknown;
        getRoomId?: () => string | undefined;
      };
      if (typeof candidate.roomId === 'string') return candidate.roomId;
      const fromEvent = candidate.getRoomId?.();
      if (typeof fromEvent === 'string') return fromEvent;
    }
  }
  return undefined;
}

/**
 * `next`, or `previous` when it describes the room identically.
 *
 * A full rebuild builds every joined room's summary, and an incremental one the rooms an event
 * touched (#1292). Handing back the previous object for a room that didn't change keeps its OnPush sidebar row from re-rendering, and
 * lets {@link sameRooms} keep the whole list when no room changed at all.
 */
function reuseUnchanged(
  previous: RoomSummary | undefined,
  next: RoomSummary,
): RoomSummary {
  if (!previous) return next;
  for (const key of Object.keys(next) as (keyof RoomSummary)[]) {
    const a = previous[key];
    const b = next[key];
    if (a === b) continue;
    if (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => item === b[i])
    ) {
      continue;
    }
    return next;
  }
  // A key the previous summary had and this one dropped (an optional field cleared).
  return Object.keys(previous).length === Object.keys(next).length
    ? previous
    : next;
}

/** Same rooms, in the same order, as the same objects: nothing for a consumer to redo. */
function sameRooms(
  a: readonly RoomSummary[],
  b: readonly RoomSummary[],
): boolean {
  return a.length === b.length && a.every((room, i) => room === b[i]);
}

/** Whether two typing-name lists say the same thing, in order. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * Read model over the synced `MatrixClient`: exposes joined rooms as plain view models
 * (components never touch `matrix-js-sdk` directly). Signals are recomputed as the
 * client syncs; Application Runtime retains the projection lifetime.
 *
 * Spaces (the server rail) are a separate read model — see {@link SpacesService}.
 * Space rooms are excluded from {@link rooms} so they never appear as channels.
 */
@Injectable({ providedIn: 'root' })
export class RoomLibraryService {
  private readonly matrix = inject(MatrixClientService);
  private readonly privacy = inject(PrivacySettingsService);
  private readonly governance = inject(ROOM_LIBRARY_GOVERNANCE_POLICY);

  /**
   * The other party in each of our DMs, refreshed by {@link refresh}. A DM has no
   * `m.room.avatar`, so its row's picture comes from this member — which makes the room
   * list depend on member state, where before it depended only on room state.
   */
  private dmPeers: ReadonlySet<string> = new Set();
  /** DM room → peer, from the last full rebuild; an `m.direct` change forces another one. */
  private userByRoom: ReadonlyMap<string, string> = new Map();
  /** A sync landed since the last refresh; see {@link markChangedRooms}. */
  private compareOnRefresh = false;

  /**
   * Marked-unread writes shown before /sync confirms them, keyed by room id.
   *
   * An entry is dropped as soon as the synced room agrees with it, so this holds only
   * genuinely in-flight state rather than shadowing the server indefinitely.
   */
  private readonly pendingUnread = new Map<string, boolean>();

  /**
   * Rooms an event changed since the last rebuild (#1292). A sync rebuilds only these and
   * keeps every other summary as it was; at 300 rooms, rebuilding every summary on every
   * sync was most of the room list's per-sync cost. Global changes (a joined or left room,
   * `m.direct`, push rules, a new client) set {@link fullRebuild} instead.
   */
  private dirtyRooms = new Set<string>();
  private fullRebuild = true;
  /** When the list was last rebuilt in full; see {@link FULL_REBUILD_MS}. */
  private lastFullRebuild = 0;

  /** Mark one room for the next rebuild and schedule it (coalesced per microtask). */
  private touch(roomId: string | undefined): void {
    if (roomId) {
      this.dirtyRooms.add(roomId);
    } else {
      this.fullRebuild = true;
    }
    this.projection.schedule();
  }

  /**
   * An event that changes one room's summary. Every room event the SDK re-emits at the
   * client passes the room (or an event naming it) among its arguments.
   */
  private readonly onRoomEvent = (...args: unknown[]): void => {
    this.touch(roomIdOf(args));
  };

  /** A state event: a room's name, avatar, topic or encryption. */
  private readonly onRoomStateEvent = (
    _event: MatrixEvent,
    state: RoomState,
  ): void => {
    this.touch(state.roomId);
  };

  /**
   * An encrypted room's message decrypted. Its notification count is only recomputed then,
   * after the Sync that carried the ciphertext, so the room has to be rebuilt again.
   */
  private readonly onDecrypted = (event: MatrixEvent): void => {
    this.touch(event?.getRoomId?.());
  };

  /**
   * A sync landed: the next refresh compares every room's counts and activity time with its
   * summary. Only after a sync, because the counts change there, and every room event also
   * schedules a refresh: walking every room on each one cost more than it saved.
   */
  private readonly onSync = (): void => {
    this.compareOnRefresh = true;
    this.projection.schedule();
  };

  /** A room joined the client. */
  private readonly onListChanged = (): void => {
    this.fullRebuild = true;
    this.projection.schedule();
  };

  /**
   * Global account data changed. Only `m.direct` reaches a summary (DM-ness and the peer
   * whose avatar a DM shows); recent emoji, secret storage and app settings do not.
   */
  private readonly onGlobalAccountData = (event?: MatrixEvent): void => {
    if (event?.getType?.() === EventType.Direct) {
      this.onListChanged();
    }
  };

  /**
   * Our OWN membership changed (joined/left a room): rebuild the whole list, and clear
   * transient typing state for a Room we left; Room Administration owns rosters.
   */
  private readonly onMyMembership = (room?: { roomId?: string }): void => {
    // Joining or leaving changes which rooms are in the list at all.
    this.fullRebuild = true;
    this.projection.schedule();
    // A room we have left stops syncing, so its members never emit the "stopped typing"
    // transition and its key would sit in the map for the rest of the session — visible
    // again the moment the room is rejoined, and frozen there, because an unchanged set
    // writes nothing.
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

  /** Someone in a room joined, left, or changed their profile. */
  private readonly onMemberChanged = (
    _event: MatrixEvent,
    state: RoomState,
    member: RoomMember,
  ): void => {
    void state;
    // A DM peer's profile can arrive or change without a sync — `loadMembersIfNeeded`
    // from opening a member list, say — and their avatar IS the room's picture. Gated
    // on the DM map so a member event in a large room does not rebuild the whole room
    // list, which is exactly why this listener was kept out of the coalesced rebuild.
    if (this.dmPeers.has(member.userId)) {
      this.touch(member.roomId);
    }
  };

  private readonly _typingByRoom = signal<Record<string, readonly string[]>>(
    {},
  );
  /**
   * Who is typing, per room, excluding the local user — the sidebar's source.
   *
   * `TimelineService` tracks this too, but only for the ONE open room, which is why the
   * sidebar could not show it before. This listener is client-level, so it sees every room
   * the user is in.
   */
  readonly typingByRoom = this._typingByRoom.asReadonly();

  private readonly dirtyTypingRooms = new Map<string, string[]>();

  /**
   * Coalesced, and deliberately separate from the Room-list projection.
   *
   * Adding `RoomMemberEvent.Typing` to the projection's `events` list would run a full
   * room-list rebuild and re-sort on every typing EDU from every room. This writes one key.
   * Room Administration owns membership projections separately, so there is no roster
   * flusher here for typing work to share.
   */
  private readonly typingFlusher = coalesce(() => {
    const rooms = [...this.dirtyTypingRooms];
    this.dirtyTypingRooms.clear();
    const client = this.projection.client();
    if (!client) {
      return;
    }
    // EVERY signed-in account, not just the active one. A room both accounts are joined to
    // renders as ONE row (see `RoomSummary.accountIds`), so filtering only the active mxid
    // let the user's own other account announce itself on their own room — the same failure
    // the self-exclusion exists to prevent, arriving by the back door.
    // EVERY signed-in account, not just the active one. A room both accounts are joined to
    // renders as ONE row (see `RoomSummary.accountIds`), so filtering only the active mxid
    // let the user's own other account announce itself on their own room — the same failure
    // the self-exclusion exists to prevent, arriving by the back door.
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
   * A member started or stopped typing. The event names the member, not the set, so the
   * room's whole typing set is re-read on flush.
   */
  private readonly onTypingChanged = (
    event: MatrixEvent,
    member: RoomMember,
  ): void => {
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

  private readonly _rooms = signal<RoomSummary[]>([], { equal: sameRooms });
  readonly rooms = this._rooms.asReadonly();

  /**
   * App-wide unread total: the sum of every joined room's unread notification
   * count. Drives the app-icon badge on every platform (see AppBadgeService).
   */
  readonly totalUnread = computed(() =>
    this.rooms().reduce((sum, r) => sum + r.unreadCount, 0),
  );

  /**
   * Room ids the `m.direct` account-data map records as direct messages, recomputed
   * on each {@link refresh}. Lets read-only consumers (e.g. the quick switcher) tag a
   * joined room as a DM without re-reading account data themselves. Non-authoritative
   * for membership — a DM we have left still appears here until the map is rewritten.
   */
  private readonly _directRoomIds = signal<ReadonlySet<string>>(new Set());
  readonly directRoomIds = this._directRoomIds.asReadonly();

  /**
   * One active-Account Projection Runtime entry: {@link projectFromClient} owns listener
   * identity, coalescing, switching, and acknowledgement; only the rebuild and its listeners stay here.
   */
  private readonly projection = projectFromClient({
    id: 'rooms.list',
    matrix: this.matrix,
    // refresh() writes signals, which schedule change detection, so the room list and
    // unread badges surface immediately.
    rebuild: () => this.refresh(),
    // Bound by hand because typing has its own per-Room coalescer and member changes only
    // rebuild the Room list when a DM peer's profile affects its summary. Room
    // Administration owns the member-roster projection itself.
    bind: (client) => {
      client.on(RoomStateEvent.Members, this.onMemberChanged);
      client.on(RoomEvent.MyMembership, this.onMyMembership);
      client.on(RoomMemberEvent.Typing, this.onTypingChanged);
      for (const event of ROOM_EVENTS) client.on(event, this.onRoomEvent);
      client.on(RoomStateEvent.Events, this.onRoomStateEvent);
      client.on(MatrixEventEvent.Decrypted, this.onDecrypted);
      client.on(ClientEvent.Room, this.onListChanged);
      client.on(ClientEvent.AccountData, this.onGlobalAccountData);
      client.on(ClientEvent.Sync, this.onSync);
      this.fullRebuild = true;
    },
    unbind: (client) => {
      client.off(RoomStateEvent.Members, this.onMemberChanged);
      client.off(RoomEvent.MyMembership, this.onMyMembership);
      client.off(RoomMemberEvent.Typing, this.onTypingChanged);
      for (const event of ROOM_EVENTS) client.off(event, this.onRoomEvent);
      client.off(RoomStateEvent.Events, this.onRoomStateEvent);
      client.off(MatrixEventEvent.Decrypted, this.onDecrypted);
      client.off(ClientEvent.Room, this.onListChanged);
      client.off(ClientEvent.AccountData, this.onGlobalAccountData);
      client.off(ClientEvent.Sync, this.onSync);
    },
    reset: () => {
      this.dirtyRooms.clear();
      this.fullRebuild = true;
      this._rooms.set([]);
      this._directRoomIds.set(new Set());
      this.dmPeers = new Set();
      // The typing map is protected one layer earlier too: its flusher reads
      // `projection.client()` and returns when there is none, so a late flush cannot
      // repopulate from the outgoing client. Cancelling also skips that pointless
      // microtask. The suite pins the outcome: the map is empty and the listener detached
      // after a disconnect. Reset also explicitly owns every scheduled task this service
      // creates.
      this.typingFlusher.cancel();
      this.dirtyTypingRooms.clear();
      this._typingByRoom.set({});
    },
  });

  /** Cold active-Account projection retained by the Room Library session lifetime. */
  runProjection(): Observable<void> {
    return this.projection.run();
  }

  /**
   * Whether Workspace may select this Room. `unconfirmed`: the Account's client is live and
   * the id is well-formed, but the client does not hold the Room (yet) — the Conversation
   * decides (pending before sync, unavailable after). `unavailable`: never navigate here.
   */
  selectionAvailability(
    accountId: string,
    roomId: string,
  ): RoomLibrarySelectionAvailability {
    const client = this.matrix.clientFor(accountId);
    if (!client || !roomId.startsWith('!')) return 'unavailable';
    return client.getRoom(roomId) ? 'available' : 'unconfirmed';
  }

  /**
   * Read the standard Room tags for one exact Account-and-Room selection.
   *
   * Room tags arrive through `/sync`, so the SDK Room is the authoritative local source.
   * `null` means that exact Account or joined Room is unavailable; callers must not
   * substitute a merged sidebar row or an active-Account default.
   */
  organisationFor(
    accountId: string,
    roomId: string,
  ): RoomOrganisationSnapshot | null {
    const room = this.matrix.clientFor(accountId)?.getRoom(roomId);
    if (!room || room.getMyMembership() !== 'join') {
      return null;
    }
    return {
      favourite: room.tags?.['m.favourite'] !== undefined,
      lowPriority: room.tags?.['m.lowpriority'] !== undefined,
    };
  }

  /**
   * Favourite (or unfavourite) a room by writing/clearing the standard Matrix `m.favourite`
   * room tag — persisted in account data and synced across devices (interops with
   * Element). Cold: the write starts on subscribe and errors reach the subscriber.
   * The post-write {@link refresh} makes the local change land immediately; the
   * `RoomEvent.Tags` listener also reconciles the authoritative sync echo.
   */
  setFavourite(
    roomId: string,
    favourite: boolean,
    accountId?: string,
  ): Observable<void> {
    return this.setTag(roomId, 'm.favourite', favourite, accountId);
  }

  /**
   * Add or remove the room's `m.lowpriority` tag, on the account that owns the row.
   *
   * Mirrors {@link setFavourite} exactly, including its cold finite command shape and
   * writing an empty tag body: Matrix tags carry an optional `order`, and Trinity does not
   * use it — ordering within the group comes from the active sort mode, not from the tag.
   */
  setLowPriority(
    roomId: string,
    lowPriority: boolean,
    accountId?: string,
  ): Observable<void> {
    return this.setTag(roomId, 'm.lowpriority', lowPriority, accountId);
  }

  /** Persist one standard Matrix room tag and refresh after the SDK accepts the write. */
  private setTag(
    roomId: string,
    tag: 'm.favourite' | 'm.lowpriority',
    enabled: boolean,
    accountId?: string,
  ): Observable<void> {
    return defer(() => {
      const client = this.clientOwning(accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      const write = enabled
        ? client.setRoomTag(roomId, tag, {})
        : client.deleteRoomTag(roomId, tag);
      return from(write).pipe(
        tap(() => {
          this.dirtyRooms.add(roomId);
          this.refresh();
        }),
        map(() => void 0),
      );
    });
  }

  /**
   * Leave a joined room. Cold — runs on subscribe. On success the client emits
   * `RoomEvent.MyMembership`, which drops the room from {@link rooms} (the list is
   * filtered to `join`), so no explicit refresh is needed; errors reach the subscriber.
   */
  leave(roomId: string, accountId?: string): Observable<void> {
    return defer(() => {
      const client = this.clientOwning(accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(client.leave(roomId)).pipe(map(() => void 0));
    });
  }

  /**
   * The client that owns a row's room: the named account's when one is given (the
   * mixed-account view, where a row may belong to a signed-in account that isn't active),
   * else the active client. Null when there is no such client — the caller decides whether
   * that is a silent no-op or an error.
   */
  private clientOwning(accountId?: string): MatrixClient | null {
    if (accountId) {
      return this.matrix.clientFor(accountId);
    }
    return this.matrix.isInitialized ? this.matrix.instance : null;
  }

  /**
   * Mark a room read: ack its latest confirmed event with a read receipt + fully-read
   * marker, clearing its unread badge. Cold — runs on subscribe; a no-op for an empty
   * or unknown room. The client emits the receipt so {@link rooms} re-derives the badge.
   */
  markRead(roomId: string, accountId?: string): Observable<void> {
    return defer(() => {
      const client = this.clientOwning(accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      const room = client.getRoom(roomId);
      const events = room?.getLiveTimeline().getEvents() ?? [];
      // Walk backward for the newest confirmed (non-local-echo) event — no array
      // copy/reverse, since the caller runs this per unread room.
      let latest: (typeof events)[number] | undefined;
      for (let i = events.length - 1; i >= 0; i--) {
        if (!events[i].status) {
          latest = events[i];
          break;
        }
      }
      // Clear the flag first, and unconditionally: an empty room returns early below,
      // but a room flagged unread and then marked read must stop being flagged whether
      // or not there is an event to acknowledge.
      const latestId = latest?.getId();
      if (!latest || !latestId) {
        return this.clearMarkedUnreadOn(roomId, accountId);
      }
      // Honor the read-receipt privacy setting: when off, ack privately
      // (`m.read.private`) so the badge clears without telling other members —
      // mirroring the auto-on-view path in TimelineService.markRead.
      const receiptType = this.privacy.sendReadReceipts()
        ? ReceiptType.Read
        : ReceiptType.ReadPrivate;
      return this.clearMarkedUnreadOn(roomId, accountId).pipe(
        concatMap(() =>
          forkJoin([
            from(client.setRoomReadMarkers(roomId, latestId)),
            from(client.sendReadReceipt(latest, receiptType)),
          ]),
        ),
        map(() => void 0),
      );
    });
  }

  /**
   * Flag a room to come back to, or clear that flag (`m.marked_unread`, MSC2867).
   *
   * Room account data, so it syncs to the user's other devices and interops with Element.
   * The read receipt is deliberately untouched: the point is to say "I have seen this and
   * still want it in front of me", which a receipt cannot express. Clearing writes
   * `{unread: false}` rather than redacting, which is what other clients read back.
   *
   * Cold and finite like {@link setFavourite}: the optimistic {@link refresh} makes the
   * change land at once after subscription, and the `RoomEvent.AccountData` listener
   * covers the echo. Write failures reach the subscriber and roll the overlay back.
   */
  setMarkedUnread(
    roomId: string,
    unread: boolean,
    accountId?: string,
  ): Observable<void> {
    return defer(() => {
      const client = this.clientOwning(accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      // Shown before the server confirms, because there is nothing else to show:
      // `setRoomAccountData` is a bare PUT with no local echo, and `Room.accountData` is
      // only ever written from /sync — so a post-write refresh alone re-reads the OLD
      // value and the row would not change until the sync echo landed.
      this.pendingUnread.set(roomId, unread);
      this.dirtyRooms.add(roomId);
      this.refresh();
      return from(
        client.setRoomAccountData(roomId, EventType.MarkedUnread, { unread }),
      ).pipe(
        map(() => void 0),
        catchError((err: unknown) => {
          this.pendingUnread.delete(roomId); // put the row back
          this.dirtyRooms.add(roomId);
          this.refresh();
          return throwError(() => err);
        }),
      );
    });
  }

  /**
   * Drop a room's marked-unread flag wherever it is actually set.
   *
   * Sweeps every signed-in account rather than taking one: a row merged from two mixed
   * accounts can be flagged on either, and clearing only the active one would leave the
   * row still reading as unread with no obvious way to fix it. Writes nothing for an
   * account that does not hold the flag, so this is cheap to call on every room open.
   */
  clearMarkedUnread(roomId: string): Observable<void> {
    return defer(() => {
      const clears = this.matrix
        .accountIds()
        .map((accountId) => this.clearMarkedUnreadOn(roomId, accountId));
      return clears.length
        ? forkJoin(clears).pipe(map(() => void 0))
        : of(void 0);
    });
  }

  /**
   * Drop the flag on ONE account, and only if it is actually set.
   *
   * The single definition of "clear the flag", shared by {@link clearMarkedUnread} and by
   * {@link markRead} — the two must not drift, and checking first is what keeps this cheap
   * enough to call on every room open.
   *
   * Cold and finite: a failed clear reaches the owning workflow, which may deliberately
   * suppress noisy room-open failures while still owning the subscription lifecycle.
   */
  private clearMarkedUnreadOn(
    roomId: string,
    accountId?: string,
  ): Observable<void> {
    return defer(() => {
      const room = this.clientOwning(accountId)?.getRoom(roomId);
      return room && isMarkedUnread(room)
        ? this.setMarkedUnread(roomId, false, accountId)
        : of(void 0);
    });
  }

  /**
   * Create a standalone (not space-linked) E2EE room and resolve its room id. Like
   * {@link SpacesService.createRoomInSpace} the room carries `m.room.encryption`
   * (Megolm) in its `initial_state` so it is encrypted from the first event, but it
   * is not linked into any space. It surfaces in {@link rooms} once the client syncs
   * the new room (the existing listeners pick it up). Cold: runs on subscribe.
   */
  createRoom(options: CreateRoomOptions): Observable<string> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return createEncryptedRoom(this.matrix.instance, options);
    });
  }

  /** Create an encrypted Room on one immutable Account, independent of later activation. */
  createRoomFor(
    accountId: string,
    options: CreateRoomOptions,
  ): Observable<string> {
    return defer(() => {
      const client = this.matrix.clientFor(accountId);
      if (!client) {
        return throwError(() => new Error('Account unavailable.'));
      }
      return createEncryptedRoom(client, options);
    });
  }

  /**
   * Resolve a room id or alias to a room id. A `!id:hs` resolves immediately; a
   * `#alias:hs` is looked up on the homeserver. Cold: runs on subscribe. Used to route
   * `matrix.to` room permalinks (which may carry either form) to an actual room.
   */
  resolveRoomId(roomIdOrAlias: string): Observable<string> {
    return defer(() => {
      if (roomIdOrAlias.startsWith('!')) {
        return of(roomIdOrAlias);
      }
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(this.matrix.instance.getRoomIdForAlias(roomIdOrAlias)).pipe(
        map((res) => res.room_id),
      );
    });
  }

  /**
   * Open (or reuse) a 1:1 direct message with `userId` and resolve its room id.
   *
   * If `m.direct` account data already records a DM with this user that we have not
   * left, that room is reused (resolving immediately) so repeated "message" actions
   * don't spawn duplicate DMs. Otherwise a new invite-only, encrypted room is created
   * (`is_direct`, `trusted_private_chat` preset, the user invited, Megolm enabled)
   * and registered in the `m.direct` map so both ends — and a future reuse — treat it
   * as a DM. Rejects when `userId` isn't a valid MXID. Cold: runs on subscribe.
   */
  createDirectMessage(userId: string): Observable<string> {
    return defer(() => {
      if (!isValidUserId(userId)) {
        return throwError(() => new Error(`Invalid user id: ${userId}`));
      }
      const client = this.matrix.instance;
      const existing = this.existingDirectRoom(client, userId);
      if (existing) {
        return of(existing);
      }
      return from(
        client.createRoom({
          is_direct: true,
          invite: [userId],
          preset: Preset.TrustedPrivateChat,
          initial_state: [roomEncryptionInitialState()],
        }),
      ).pipe(
        switchMap((res) =>
          this.addToDirectMap(client, userId, res.room_id).pipe(
            map(() => res.room_id),
          ),
        ),
      );
    });
  }

  /**
   * Invite `userId` to `roomId` — works for both rooms and spaces (a space is just a
   * room). Rejects when `userId` isn't a valid MXID. Cold: runs on subscribe.
   */
  inviteUser(
    target: string | RoomLibraryGovernanceKey,
    userId: string,
  ): Observable<void> {
    return defer(() => {
      if (!isValidUserId(userId)) {
        return throwError(() => new Error(`Invalid user id: ${userId}`));
      }
      const client =
        typeof target === 'string'
          ? this.matrix.isInitialized
            ? this.matrix.instance
            : null
          : this.matrix.clientFor(target.accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      const accountId = client.getUserId();
      if (!accountId) return throwError(() => new Error('Not signed in.'));
      const roomId = typeof target === 'string' ? target : target.roomId;
      assertRoomLibraryGovernance(
        this.governance.authorize({ accountId, roomId }, 'invite'),
      );
      return from(client.invite(roomId, userId)).pipe(map(() => void 0));
    });
  }

  /**
   * The id of an existing, not-left DM room with `userId` from the `m.direct`
   * account-data map, or null. A joined room is preferred; an outstanding invite we
   * sent (membership `invite`) is also reused so we don't create a second DM while
   * the first is pending. Rooms we have left (or that no longer exist) are skipped.
   */
  private existingDirectRoom(
    client: MatrixClient,
    userId: string,
  ): string | null {
    const candidates = this.directMap(client)[userId] ?? [];
    let firstUsable: string | null = null;
    for (const roomId of candidates) {
      const room = client.getRoom(roomId);
      const membership = room?.getMyMembership();
      if (membership === 'join') {
        return roomId; // a live DM — prefer it
      }
      if (!firstUsable && membership === 'invite') {
        firstUsable = roomId; // pending invite we sent — usable fallback
      }
    }
    return firstUsable;
  }

  /** Merge `roomId` into `m.direct[userId]` and persist the updated map. */
  private addToDirectMap(
    client: MatrixClient,
    userId: string,
    roomId: string,
  ): Observable<void> {
    // `setAccountData` does a *full replace* of m.direct, so merge against the
    // freshest map, re-read at write time (inside the defer, on subscribe) — not
    // a snapshot taken before `createRoom`. Otherwise an m.direct update that
    // arrived during the create round-trip (another device / a concurrent DM)
    // would be clobbered by our PUT.
    return defer(() => {
      const current = this.directMap(client);
      const forUser = current[userId] ?? [];
      if (forUser.includes(roomId)) {
        return of(void 0); // already recorded — nothing to write
      }
      const next = { ...current, [userId]: [...forUser, roomId] };
      return from(client.setAccountData(EventType.Direct, next)).pipe(
        map(() => void 0),
      );
    });
  }

  /**
   * Current `m.direct` map (`{ userId: roomId[] }`), or an empty map when unset. The
   * accessor is called optionally so a stub client without account data (e.g. unit
   * fakes for the sync-driven read model) yields an empty map rather than throwing.
   */
  private directMap(client: MatrixClient): Record<string, string[]> {
    return (
      client
        .getAccountData?.(EventType.Direct)
        ?.getContent<Record<string, string[]>>() ?? {}
    );
  }

  private refresh(): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    const client = this.matrix.instance;
    const accountId = this.matrix.activeUserId() ?? client.getUserId?.() ?? '';
    const now = Date.now();
    if (!this.fullRebuild && now - this.lastFullRebuild < FULL_REBUILD_MS) {
      this.refreshTouched(client, accountId);
      return;
    }
    this.fullRebuild = false;
    this.compareOnRefresh = false;
    this.lastFullRebuild = now;
    this.dirtyRooms.clear();
    const { ids: direct, userByRoom } = directMapOf(client);

    const previous = new Map(
      untracked(this._rooms).map((room) => [room.id, room] as const),
    );
    this._rooms.set(
      client
        .getRooms()
        // Spaces are rendered in the server rail, not as channels in the room list.
        .filter((r) => !r.isSpaceRoom() && r.getMyMembership() === 'join')
        .map((r) =>
          reuseUnchanged(
            previous.get(r.roomId),
            this.applyPendingUnread(
              buildRoomSummary(r, accountId, userByRoom.get(r.roomId)),
            ),
          ),
        )
        .sort(compareRoomSummaries),
    );
    this._directRoomIds.set(direct);
    this.dmPeers = new Set(userByRoom.values());
    this.userByRoom = userByRoom;
  }

  /** Rebuild just the rooms an event touched, keeping every other summary as it was. */
  private refreshTouched(client: MatrixClient, accountId: string): void {
    const current = untracked(this._rooms);
    if (this.compareOnRefresh) {
      this.compareOnRefresh = false;
      this.markChangedRooms(client, current);
    }
    if (this.dirtyRooms.size === 0) {
      return;
    }
    const touched = this.dirtyRooms;
    this.dirtyRooms = new Set();
    const userByRoom = this.userByRoom;
    const byId = new Map(current.map((room) => [room.id, room] as const));
    let changed = false;
    for (const roomId of touched) {
      const room = client.getRoom(roomId);
      const listed =
        !!room && !room.isSpaceRoom() && room.getMyMembership() === 'join';
      if (!listed) {
        changed = byId.delete(roomId) || changed;
        continue;
      }
      const previous = byId.get(roomId);
      const next = reuseUnchanged(
        previous,
        this.applyPendingUnread(
          buildRoomSummary(room, accountId, userByRoom.get(roomId)),
        ),
      );
      if (next !== previous) {
        byId.set(roomId, next);
        changed = true;
      }
    }
    if (changed) {
      this._rooms.set([...byId.values()].sort(compareRoomSummaries));
    }
  }

  /**
   * Mark every listed room whose counts or activity time no longer match its summary.
   *
   * Both change without any event this service hears. A sync can carry only a room's
   * `unread_notifications`, and the SDK's start-up `fixupRoomNotifications` corrects counts
   * on the first prepared sync: `RoomEvent.UnreadNotifications` is emitted only on the Room,
   * never re-emitted at the client. A new thread's bundled latest reply moves the room's
   * activity time (#1230) through `ThreadEvent.Update`, which is not re-emitted either. These
   * few reads per room are far cheaper than rebuilding its summary, and they close all of it.
   */
  private markChangedRooms(
    client: MatrixClient,
    current: readonly RoomSummary[],
  ): void {
    for (const summary of current) {
      if (this.dirtyRooms.has(summary.id)) continue;
      const room = client.getRoom(summary.id);
      if (
        !room ||
        room.getUnreadNotificationCount(NotificationCountType.Total) !==
          summary.unreadCount ||
        room.getUnreadNotificationCount(NotificationCountType.Highlight) !==
          summary.highlightCount ||
        roomActivityTs(room) !== summary.activityTs
      ) {
        this.dirtyRooms.add(summary.id);
      }
    }
  }

  /** Overlay an in-flight marked-unread write, and forget it once /sync agrees. */
  private applyPendingUnread(summary: RoomSummary): RoomSummary {
    const pending = this.pendingUnread.get(summary.id);
    if (pending === undefined) {
      return summary;
    }
    if (pending === summary.markedUnread) {
      this.pendingUnread.delete(summary.id); // the echo landed; the server owns it again
      return summary;
    }
    return {
      ...summary,
      markedUnread: pending,
      hasUnread: summary.unreadCount > 0 || pending,
    };
  }
}
