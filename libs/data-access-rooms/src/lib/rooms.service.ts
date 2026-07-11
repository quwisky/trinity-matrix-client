import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import {
  ClientEvent,
  EventType,
  MatrixEventEvent,
  NotificationCountType,
  Preset,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type Room,
  type RoomMember,
} from 'matrix-js-sdk';
import {
  Observable,
  defer,
  forkJoin,
  from,
  map,
  of,
  switchMap,
  throwError,
} from 'rxjs';
import {
  MatrixClientService,
  reprojectOnAccountSwitch,
} from '@trinity/data-access-matrix-client';
import { messagePreview } from '@trinity/util-matrix';
import {
  isValidUserId,
  roomEncryptionInitialState,
  visibilityOptions,
} from '@trinity/util-matrix';

/** Fields a {@link RoomsService.createRoom} call accepts. */
export interface CreateRoomOptions {
  name: string;
  topic?: string;
  /** Public (discoverable + publicly joinable) vs the default invite-only room. */
  isPublic?: boolean;
}

/** A user-directory hit shown in the invite / DM picker. */
export interface UserSearchResult {
  userId: string;
  /** Display name, falling back to the user id when the server has none. */
  displayName: string;
  /** Raw `mxc://` avatar, or null when unset; the UI resolves it (authed). */
  avatarMxc: string | null;
}

/** A joinable room shown in the channel sidebar. */
export interface RoomSummary {
  id: string;
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
  /** Convenience flag: there are unread notifications. */
  hasUnread: boolean;
  /** Single-line preview of the room's most recent message (`''` when none). */
  lastMessage: string;
  /** Last-activity timestamp (ms), used to order the list by recency. */
  activityTs: number;
  /** Whether the room carries the `m.favourite` tag — favourite to the top of the list. */
  favourite: boolean;
  /**
   * For a direct message, the other participant's user id (from the `m.direct` map);
   * undefined for a non-DM room. Lets the sidebar show the counterpart's online status.
   */
  directUserId?: string;
}

/** A joined member shown in the member list. */
export interface MemberSummary {
  userId: string;
  name: string;
  initial: string;
  avatarMxc: string | null;
  /**
   * The member's power level in the room. By Matrix convention 100 is an admin and
   * 50 a moderator; the member list groups members into role sections from this.
   */
  powerLevel: number;
}

/**
 * Read model over the synced `MatrixClient`: exposes joined rooms and members as
 * plain view models (components never touch `matrix-js-sdk` directly). Signals are
 * recomputed as the client syncs; `connect()` wires the listeners.
 *
 * Spaces (the server rail) are a separate read model — see {@link SpacesService}.
 * Space rooms are excluded from {@link rooms} so they never appear as channels.
 */
@Injectable({ providedIn: 'root' })
export class RoomsService {
  private readonly matrix = inject(MatrixClientService);
  private readonly zone = inject(NgZone);

  /**
   * The client we currently have listeners on. The client is recreated on every
   * (re-)login, so connection is keyed to the instance, not a boolean — otherwise
   * a logout→login would leave the listeners on the discarded client and the read
   * model frozen.
   */
  private connectedClient: MatrixClient | null = null;

  /**
   * Stable listener ref so {@link connect}/{@link disconnect} can add and remove it.
   * Listener-driven refreshes are coalesced ({@link scheduleRefresh}): one completed
   * /sync fires a burst of Sync/Room/Receipt events, and rebuilding the whole read
   * model (O(rooms) + a full re-sort) once per event is wasteful — collapse them
   * into a single rebuild.
   */
  private readonly onClientEvent = (): void => this.scheduleRefresh();

  /** Whether a coalesced refresh is already queued for this microtask turn. */
  private refreshScheduled = false;

  /**
   * Bumped only on membership changes (`RoomState.members`/`MyMembership`) so a
   * member-list projection can stay reactive *without* re-running on every sync
   * tick or read receipt — those bump {@link revision} (which drives the room list)
   * but never change a room's membership. See {@link membersOf}.
   */
  private readonly _memberRevision = signal(0);
  readonly memberRevision = this._memberRevision.asReadonly();
  private readonly onMembershipEvent = (): void =>
    // Matrix events fire outside Angular's zone; re-enter so the signal write
    // triggers change detection (mirrors scheduleRefresh below).
    this.zone.run(() => this._memberRevision.update((n) => n + 1));

  // Memoized member projection: a cached, sorted list per room keyed by a cheap
  // fingerprint of its joined members, plus one shared collator (avoids spinning up
  // a fresh locale comparator on every sort). `localeCompare()` with no args is
  // equivalent to a default `Intl.Collator`, so the order is unchanged.
  private readonly memberCollator = new Intl.Collator();
  private readonly memberCache = new Map<
    string,
    { sig: string; list: MemberSummary[] }
  >();

  private readonly _rooms = signal<RoomSummary[]>([]);
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

  /** Bumped on every refresh so member queries can stay reactive. */
  private readonly _revision = signal(0);
  readonly revision = this._revision.asReadonly();

  constructor() {
    // On an account switch, re-project this service onto the newly-active account's
    // client — but only while it is already wired to one.
    reprojectOnAccountSwitch(
      this.matrix,
      () => this.connectedClient !== null,
      () => this.connect(),
    );
  }

  /**
   * Attach sync listeners and do the first read. Idempotent per client (e.g. the
   * shell's `ngOnInit`); re-running after a re-login rewires onto the new client.
   */
  connect(): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    const client = this.matrix.instance;
    if (this.connectedClient === client) {
      return; // already wired to this client
    }
    this.disconnect(); // drop listeners from any previous client
    this.connectedClient = client;
    client.on(ClientEvent.Sync, this.onClientEvent);
    client.on(ClientEvent.Room, this.onClientEvent);
    client.on(RoomEvent.Name, this.onClientEvent);
    client.on(RoomEvent.MyMembership, this.onClientEvent);
    // Keep unread badges live. In an encrypted room the notification count is
    // only recomputed once the message DECRYPTS (async), which lands after the
    // Sync that carried the ciphertext — so relying on Sync alone drops those
    // increments. Decrypted (re-emitted at the client) fires when that happens,
    // so we re-read the now-updated count. Receipt fires when a room is read and
    // its count clears. (UnreadNotifications is Room-only, not re-emitted here.)
    client.on(MatrixEventEvent.Decrypted, this.onClientEvent);
    client.on(RoomEvent.Receipt, this.onClientEvent);
    // Room tags (e.g. `m.favourite`, the favourite flag) can change from another device;
    // rebuild so a remote favourite/unfavourite re-partitions and re-sorts the list live.
    client.on(RoomEvent.Tags, this.onClientEvent);
    // Membership-only revision (drives the member list); RoomState.members and
    // MyMembership are the events that change who is in a room (or their profile).
    client.on(RoomStateEvent.Members, this.onMembershipEvent);
    client.on(RoomEvent.MyMembership, this.onMembershipEvent);
    this.refresh();
  }

  /** Detach listeners from the current client and reset the read model. */
  disconnect(): void {
    const client = this.connectedClient;
    if (!client) {
      return;
    }
    client.off(ClientEvent.Sync, this.onClientEvent);
    client.off(ClientEvent.Room, this.onClientEvent);
    client.off(RoomEvent.Name, this.onClientEvent);
    client.off(RoomEvent.MyMembership, this.onClientEvent);
    client.off(MatrixEventEvent.Decrypted, this.onClientEvent);
    client.off(RoomEvent.Receipt, this.onClientEvent);
    client.off(RoomEvent.Tags, this.onClientEvent);
    client.off(RoomStateEvent.Members, this.onMembershipEvent);
    client.off(RoomEvent.MyMembership, this.onMembershipEvent);
    this.connectedClient = null;
    this.refreshScheduled = false;
    this.memberCache.clear();
    this._rooms.set([]);
    this._directRoomIds.set(new Set());
  }

  /**
   * Coalesce a burst of sync events into a single rebuild: queue {@link refresh} on
   * the microtask after the current task drains, deduped by {@link refreshScheduled}.
   * The pending run is dropped if {@link disconnect} ran meanwhile. (The first read
   * is done synchronously by {@link connect}, so consumers see the model immediately.)
   */
  private scheduleRefresh(): void {
    if (this.refreshScheduled) {
      return;
    }
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;
      if (this.connectedClient) {
        // Matrix client events (and thus this microtask) run OUTSIDE Angular's
        // zone, so the signal writes in refresh() wouldn't schedule change
        // detection — the room list and unread badges would then only update on
        // the next incidental zone tick, up to a full ~30s /sync poll later.
        // Re-enter the zone so unread changes surface immediately.
        this.zone.run(() => this.refresh());
      }
    });
  }

  /**
   * Joined members of a room (empty if the room is unknown), sorted by name. The
   * sorted list is memoized per room against a cheap fingerprint of its joined
   * members, so a recompute (e.g. a membership change in another room ticking
   * {@link memberRevision}) reuses the same array — and the same object identity —
   * when this room's membership is unchanged, instead of re-sorting every call.
   */
  membersOf(roomId: string | null): MemberSummary[] {
    if (!roomId || !this.matrix.isInitialized) {
      return [];
    }
    const room = this.matrix.instance.getRoom(roomId);
    if (!room) {
      return [];
    }
    const joined = room.getJoinedMembers();
    // `powerLevel` is part of the fingerprint so a promotion/demotion (which fires
    // RoomState.members and keeps userId/name/avatar unchanged) still invalidates the
    // cache and re-partitions the member list into its role sections.
    const sig = joined
      .map(
        (m) =>
          `${m.userId}\x1f${m.name}\x1f${m.getMxcAvatarUrl() ?? ''}\x1f${m.powerLevel}`,
      )
      .join('\x1e');
    const cached = this.memberCache.get(roomId);
    if (cached && cached.sig === sig) {
      return cached.list;
    }
    const list = joined
      .map((m) => this.toMember(m))
      .sort((a, b) => this.memberCollator.compare(a.name, b.name));
    this.memberCache.set(roomId, { sig, list });
    return list;
  }

  /**
   * Favourite (or unfavourite) a room by writing/clearing the standard Matrix `m.favourite`
   * room tag — persisted in account data and synced across devices (interops with
   * Element). Fire-and-forget: the write is async and its promise resolves OUTSIDE
   * Angular's zone, so the post-write {@link refresh} is re-entered via `zone.run`
   * (the `RoomEvent.Tags` listener also rebuilds, but the explicit refresh makes the
   * local change land immediately). Failures are logged, not thrown.
   */
  setFavourite(roomId: string, favourite: boolean): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    const client = this.matrix.instance;
    const write = favourite
      ? client.setRoomTag(roomId, 'm.favourite', {})
      : client.deleteRoomTag(roomId, 'm.favourite');
    write
      .then(() => this.zone.run(() => this.refresh()))
      .catch((err: unknown) =>
        console.error(
          `Failed to ${favourite ? 'favourite' : 'unfavourite'} room ${roomId}`,
          err,
        ),
      );
  }

  /**
   * Leave a joined room. Cold — runs on subscribe. On success the client emits
   * `RoomEvent.MyMembership`, which drops the room from {@link rooms} (the list is
   * filtered to `join`), so no explicit refresh is needed; errors reach the subscriber.
   */
  leave(roomId: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(this.matrix.instance.leave(roomId)).pipe(map(() => void 0));
    });
  }

  /**
   * Mark a room read: ack its latest confirmed event with a read receipt + fully-read
   * marker, clearing its unread badge. Cold — runs on subscribe; a no-op for an empty
   * or unknown room. The client emits the receipt so {@link rooms} re-derives the badge.
   */
  markRead(roomId: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      const client = this.matrix.instance;
      const room = client.getRoom(roomId);
      const events = room?.getLiveTimeline().getEvents() ?? [];
      const latest = [...events].reverse().find((event) => !event.status);
      const latestId = latest?.getId();
      if (!latest || !latestId) {
        return of(void 0);
      }
      void client.setRoomReadMarkers(roomId, latestId)?.catch(() => undefined);
      return from(client.sendReadReceipt(latest)).pipe(map(() => void 0));
    });
  }

  /** Mark every room with unread messages read. Cold — acks them all in parallel. */
  markAllRead(): Observable<void> {
    return defer(() => {
      const unread = this.rooms().filter((room) => room.hasUnread);
      if (unread.length === 0) {
        return of(void 0);
      }
      return forkJoin(unread.map((room) => this.markRead(room.id))).pipe(
        map(() => void 0),
      );
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
      const client = this.matrix.instance;
      return from(
        client.createRoom({
          name: options.name.trim(),
          ...(options.topic?.trim() ? { topic: options.topic.trim() } : {}),
          ...visibilityOptions(options.isPublic),
          initial_state: [roomEncryptionInitialState()],
        }),
      ).pipe(map((res) => res.room_id));
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
  inviteUser(roomId: string, userId: string): Observable<void> {
    return defer(() => {
      if (!isValidUserId(userId)) {
        return throwError(() => new Error(`Invalid user id: ${userId}`));
      }
      return from(this.matrix.instance.invite(roomId, userId)).pipe(
        map(() => void 0),
      );
    });
  }

  /**
   * Search the homeserver user directory for an invite / DM picker. An empty term
   * resolves to `[]` without a request. Cold: runs on subscribe.
   */
  searchUsers(term: string): Observable<UserSearchResult[]> {
    const trimmed = term.trim();
    if (!trimmed) {
      return of([]);
    }
    return defer(() =>
      from(this.matrix.instance.searchUserDirectory({ term: trimmed })),
    ).pipe(
      map((res) =>
        res.results.map((u) => ({
          userId: u.user_id,
          displayName: u.display_name || u.user_id,
          avatarMxc: u.avatar_url ?? null,
        })),
      ),
    );
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
    const all = client.getRooms();

    // Reverse `m.direct` ({ userId: roomId[] }) once into the set of DM room ids AND a
    // roomId → counterpart-user-id lookup, so each DM room can carry the other party's id.
    const direct = new Set<string>();
    const directUserByRoom = new Map<string, string>();
    for (const [userId, ids] of Object.entries(this.directMap(client))) {
      if (Array.isArray(ids)) {
        for (const roomId of ids) {
          direct.add(roomId);
          if (!directUserByRoom.has(roomId)) {
            directUserByRoom.set(roomId, userId);
          }
        }
      }
    }

    this._rooms.set(
      all
        // Spaces are rendered in the server rail, not as channels in the room list.
        .filter((r) => !r.isSpaceRoom() && r.getMyMembership() === 'join')
        .map((r) => this.toRoom(r, directUserByRoom.get(r.roomId)))
        // Favourite rooms first, then most recently active; fall back to name.
        .sort(
          (a, b) =>
            Number(b.favourite) - Number(a.favourite) ||
            b.activityTs - a.activityTs ||
            a.name.localeCompare(b.name),
        ),
    );
    this._directRoomIds.set(direct);
    this._revision.update((n) => n + 1);
  }

  private toRoom(room: Room, directUserId?: string): RoomSummary {
    const name = room.name || room.roomId;
    const topicEvent = room.currentState.getStateEvents('m.room.topic', '');
    const unreadCount = room.getUnreadNotificationCount(
      NotificationCountType.Total,
    );
    const highlightCount = room.getUnreadNotificationCount(
      NotificationCountType.Highlight,
    );
    return {
      id: room.roomId,
      name,
      initial: initialOf(name),
      avatarMxc: room.getMxcAvatarUrl(),
      topic: (topicEvent?.getContent()?.['topic'] as string) ?? '',
      memberCount: room.getJoinedMemberCount(),
      encrypted: room.hasEncryptionStateEvent(),
      unreadCount,
      highlightCount,
      hasUnread: unreadCount > 0,
      lastMessage: lastMessageOf(room),
      activityTs: room.getLastActiveTimestamp(),
      favourite: room.tags?.['m.favourite'] !== undefined,
      directUserId,
    };
  }

  private toMember(member: RoomMember): MemberSummary {
    const name = member.name || member.userId;
    return {
      userId: member.userId,
      name,
      initial: initialOf(name),
      avatarMxc: member.getMxcAvatarUrl() ?? null,
      powerLevel: member.powerLevel,
    };
  }
}

/** First visible character (sans leading `#`/`@`), uppercased, for fallback avatars. */
function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}

/**
 * Single-line preview of the room's most recent `m.room.message`, or `''` when the
 * room has no message in its live timeline. The timeline is walked back-to-front so
 * membership/state events between messages are skipped. `getLiveTimeline` is called
 * optionally since not every Room stub (unit fakes) exposes it.
 */
function lastMessageOf(room: Room): string {
  const events = room.getLiveTimeline?.()?.getEvents() ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].getType() === EventType.RoomMessage) {
      return messagePreview(events[i]);
    }
  }
  return '';
}
