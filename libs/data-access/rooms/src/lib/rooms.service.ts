import {
  Injectable,
  type Signal,
  type WritableSignal,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  ClientEvent,
  EventType,
  MatrixEventEvent,
  Preset,
  ReceiptType,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type RoomMember,
  type RoomState,
} from 'matrix-js-sdk';
import {
  Observable,
  catchError,
  defer,
  from,
  map,
  of,
  switchMap,
  throwError,
} from 'rxjs';
import {
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
  initialOf,
  isMarkedUnread,
} from './room-projection';

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
  /**
   * Whether this member created the room (`m.room.create`'s sender).
   *
   * A fact about the room, not a rank: it can never be granted, transferred or revoked,
   * which is why it is a separate flag rather than another power level. Surfaces use it
   * to answer "whose room is this?", which a power level alone cannot — every admin the
   * creator has since promoted sits at the same 100.
   */
  isCreator: boolean;
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
  private readonly privacy = inject(PrivacySettingsService);

  /**
   * The other party in each of our DMs, refreshed by {@link refresh}. A DM has no
   * `m.room.avatar`, so its row's picture comes from this member — which makes the room
   * list depend on member state, where before it depended only on room state.
   */
  private dmPeers: ReadonlySet<string> = new Set();

  /**
   * Marked-unread writes shown before /sync confirms them, keyed by room id.
   *
   * An entry is dropped as soon as the synced room agrees with it, so this holds only
   * genuinely in-flight state rather than shadowing the server indefinitely.
   */
  private readonly pendingUnread = new Map<string, boolean>();

  /**
   * Our OWN membership changed (joined/left a room). The rebuild is already covered —
   * `RoomEvent.MyMembership` is in the projection's coalesced event list — so this only
   * re-reads the member lists. Kept separate from {@link onMemberChanged} because the two
   * events carry entirely different arguments: this one names no room, so every watched
   * list has to be re-read rather than one.
   */
  private readonly onMyMembership = (): void => this.rereadMembers(null);

  /** Someone in a room joined, left, or changed their profile. */
  private readonly onMemberChanged = (
    _event: MatrixEvent,
    state: RoomState,
    member: RoomMember,
  ): void => {
    // Dispatched by the room the event happened in. `RoomStateEvent.Members` fans out per
    // member — one `m.room.power_levels` change emits once for every member of the room —
    // and it is unfiltered, so it also fires for rooms nothing is watching.
    this.rereadMembers(state.roomId);
    // A DM peer's profile can arrive or change without a sync — `loadMembersIfNeeded`
    // from opening a member list, say — and their avatar IS the room's picture. Gated
    // on the DM map so a member event in a large room does not rebuild the whole room
    // list, which is exactly why this listener was kept out of the coalesced rebuild.
    if (this.dmPeers.has(member.userId)) {
      this.projection.schedule();
    }
  };

  /** One signal per room whose member list someone is watching. */
  private readonly memberSignals = new Map<
    string,
    WritableSignal<readonly MemberSummary[]>
  >();

  /**
   * A room's joined members, live — the read every member surface should use.
   *
   * Memoized per room id, so several surfaces watching one room share a signal, and seeded
   * synchronously so a caller may read it in a field initializer.
   *
   * Replaces a `memberRevision` counter that every consumer had to remember to read before
   * calling {@link membersOf}. Forgetting it produced a list that silently never updated,
   * and reading it subscribed you to membership changes in EVERY room rather than the one
   * you were showing.
   */
  membersFor(roomId: string | null): Signal<readonly MemberSummary[]> {
    const key = roomId ?? '';
    let members = this.memberSignals.get(key);
    if (!members) {
      // No `equal` needed: `membersOf` memoizes on a fingerprint and hands back the
      // IDENTICAL array when a room's membership is unchanged, so the default `Object.is`
      // already stops an unchanged re-read from propagating.
      members = signal<readonly MemberSummary[]>(this.membersOf(roomId));
      this.memberSignals.set(key, members);
    }
    return members.asReadonly();
  }

  /** Re-read one watched room's members, or every one when the event names no room. */
  private rereadMembers(roomId: string | null): void {
    if (roomId !== null) {
      this.memberSignals.get(roomId)?.set(this.membersOf(roomId));
      return;
    }
    for (const [key, members] of this.memberSignals) {
      members.set(this.membersOf(key || null));
    }
  }

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

  /**
   * Bumped on every refresh, so a derivation that resolves a USER PROFILE off the client
   * (`getUser()`) re-runs as profiles hydrate on sync. Every consumer does exactly that;
   * despite the old name and comment, no member query reads it.
   *
   * A bump counter and not a signal of data, because the thing it stands for — "some
   * profile somewhere may have changed" — has no value to carry. The honest replacement is
   * a real projection of `UserEvent.DisplayName`/`AvatarUrl`, which is deferred rather than
   * unknown: two of the consumers resolve profiles from OTHER accounts' clients, so it
   * needs the cross-account listener-set shape `MixedRoomsService` has, including its
   * `held.client === client` identity re-check. `account-badges.service.ts` already
   * documents that this signal alone is insufficient and pairs it with a second one.
   *
   * The name matters: a public signal called `revision` on a service whose room list
   * rebuilds constantly invites reuse as a generic "something changed" hook, which is the
   * habit issue #61 was filed about.
   */
  private readonly _profileRevision = signal(0);
  readonly profileRevision = this._profileRevision.asReadonly();

  /**
   * The sync projection: listeners keyed to the client instance, rebuilds coalesced into
   * one per turn, and re-projection onto the newly-active account on a switch. All three
   * are {@link projectFromClient}'s; what stays here is the event list and the rebuild.
   */
  private readonly projection = projectFromClient({
    matrix: this.matrix,
    events: [
      ClientEvent.Sync,
      ClientEvent.Room,
      RoomEvent.Name,
      RoomEvent.MyMembership,
      // Keep unread badges live. In an encrypted room the notification count is
      // only recomputed once the message DECRYPTS (async), which lands after the
      // Sync that carried the ciphertext — so relying on Sync alone drops those
      // increments. Decrypted (re-emitted at the client) fires when that happens,
      // so we re-read the now-updated count. Receipt fires when a room is read and
      // its count clears. (UnreadNotifications is Room-only, not re-emitted here.)
      MatrixEventEvent.Decrypted,
      RoomEvent.Receipt,
      // Room tags (e.g. `m.favourite`, the favourite flag) can change from another device;
      // rebuild so a remote favourite/unfavourite re-partitions and re-sorts the list live.
      RoomEvent.Tags,
      // Room account data carries the marked-unread flag, and nothing in the app
      // listened to it before — so a room flagged on another device would not have
      // surfaced here until some unrelated event happened to rebuild the list.
      RoomEvent.AccountData,
    ],
    // refresh() writes signals, which schedule change detection, so the room list and
    // unread badges surface immediately.
    rebuild: () => this.refresh(),
    // Bound by hand rather than added to `events` because these must NOT be coalesced
    // into the rebuild: they feed the per-room member signals alone, which is what keeps a
    // member list reactive without re-running the room-list rebuild on every sync tick.
    // RoomState.members and MyMembership are what change who is in a room (or their
    // profile), and `onMemberChanged` needs the event's arguments to know WHICH room.
    bind: (client) => {
      client.on(RoomStateEvent.Members, this.onMemberChanged);
      client.on(RoomEvent.MyMembership, this.onMyMembership);
    },
    unbind: (client) => {
      client.off(RoomStateEvent.Members, this.onMemberChanged);
      client.off(RoomEvent.MyMembership, this.onMyMembership);
    },
    reset: () => {
      this.memberCache.clear();
      this._rooms.set([]);
      this._directRoomIds.set(new Set());
      this.dmPeers = new Set();
    },
  });

  /**
   * Attach sync listeners and do the first read. Idempotent per client (e.g. the
   * shell's `ngOnInit`); re-running after a re-login rewires onto the new client.
   */
  connect(): void {
    this.projection.connect();
  }

  /** Detach listeners from the current client and reset the read model. */
  disconnect(): void {
    this.projection.disconnect();
  }

  /**
   * Joined members of a room (empty if the room is unknown), sorted by name — a one-shot
   * read. A surface that must stay live wants {@link membersFor}.
   *
   * The sorted list is memoized per room against a cheap fingerprint of its joined members,
   * so a re-read reuses the same array — and the same object identity — when this room's
   * membership is unchanged, instead of re-sorting every call. That identity is what lets
   * {@link membersFor} write on every member event without waking its consumers: an
   * unchanged room re-reads to the same reference and `Object.is` stops there.
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
    // Deliberately NOT part of the fingerprint above: `m.room.create` is immutable, so
    // the creator cannot change while the room exists and can never invalidate the cache.
    const creatorId = room.getCreator();
    const list = joined
      .map((m) => this.toMember(m, creatorId))
      .sort((a, b) => this.memberCollator.compare(a.name, b.name));
    this.memberCache.set(roomId, { sig, list });
    return list;
  }

  /**
   * Favourite (or unfavourite) a room by writing/clearing the standard Matrix `m.favourite`
   * room tag — persisted in account data and synced across devices (interops with
   * Element). Fire-and-forget: the write is async; on resolve the post-write
   * {@link refresh} writes signals that schedule change detection (the
   * `RoomEvent.Tags` listener also rebuilds, but the explicit refresh makes the
   * local change land immediately). Failures are logged, not thrown.
   */
  setFavourite(roomId: string, favourite: boolean, accountId?: string): void {
    const client = this.clientOwning(accountId);
    if (!client) {
      return;
    }
    const write = favourite
      ? client.setRoomTag(roomId, 'm.favourite', {})
      : client.deleteRoomTag(roomId, 'm.favourite');
    write
      .then(() => this.refresh())
      .catch((err: unknown) =>
        console.error(
          `Failed to ${favourite ? 'favourite' : 'unfavourite'} room ${roomId}`,
          err,
        ),
      );
  }

  /**
   * Add or remove the room's `m.lowpriority` tag, on the account that owns the row.
   *
   * Mirrors {@link setFavourite} exactly, including writing an empty tag body: Matrix tags
   * carry an optional `order`, and Trinity does not use it — ordering within the group comes
   * from the active sort mode, not from the tag.
   */
  setLowPriority(
    roomId: string,
    lowPriority: boolean,
    accountId?: string,
  ): void {
    const client = this.clientOwning(accountId);
    if (!client) {
      return;
    }
    const write = lowPriority
      ? client.setRoomTag(roomId, 'm.lowpriority', {})
      : client.deleteRoomTag(roomId, 'm.lowpriority');
    write
      .then(() => this.refresh())
      .catch((err: unknown) =>
        console.error(
          `Failed to ${lowPriority ? 'demote' : 'restore'} room ${roomId}`,
          err,
        ),
      );
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
      this.clearMarkedUnreadOn(roomId, accountId);
      const latestId = latest?.getId();
      if (!latest || !latestId) {
        return of(void 0);
      }
      void client.setRoomReadMarkers(roomId, latestId)?.catch(() => undefined);
      // Honor the read-receipt privacy setting: when off, ack privately
      // (`m.read.private`) so the badge clears without telling other members —
      // mirroring the auto-on-view path in TimelineService.markRead.
      const receiptType = this.privacy.sendReadReceipts()
        ? ReceiptType.Read
        : ReceiptType.ReadPrivate;
      return from(client.sendReadReceipt(latest, receiptType)).pipe(
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
   * Fire-and-forget like {@link setFavourite}: the post-write {@link refresh} makes the
   * change land at once, and the `RoomEvent.AccountData` listener covers the echo.
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
      this.refresh();
      return from(
        client.setRoomAccountData(roomId, EventType.MarkedUnread, { unread }),
      ).pipe(
        map(() => void 0),
        catchError((err: unknown) => {
          this.pendingUnread.delete(roomId); // put the row back
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
  clearMarkedUnread(roomId: string): void {
    for (const accountId of this.matrix.accountIds()) {
      this.clearMarkedUnreadOn(roomId, accountId);
    }
  }

  /**
   * Drop the flag on ONE account, and only if it is actually set.
   *
   * The single definition of "clear the flag", shared by {@link clearMarkedUnread} and by
   * {@link markRead} — the two must not drift, and checking first is what keeps this cheap
   * enough to call on every room open.
   *
   * Fire-and-forget: a failed clear leaves the row flagged, which the next open retries,
   * and a toast on every room open would be noise.
   */
  private clearMarkedUnreadOn(roomId: string, accountId?: string): void {
    const room = this.clientOwning(accountId)?.getRoom(roomId);
    if (!room || !isMarkedUnread(room)) {
      return;
    }
    this.setMarkedUnread(roomId, false, accountId).subscribe({
      error: (err: unknown) =>
        console.error('Could not clear the room’s unread flag', err),
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
    const accountId = this.matrix.activeUserId() ?? client.getUserId?.() ?? '';
    const { ids: direct, userByRoom } = directMapOf(client);

    this._rooms.set(
      client
        .getRooms()
        // Spaces are rendered in the server rail, not as channels in the room list.
        .filter((r) => !r.isSpaceRoom() && r.getMyMembership() === 'join')
        .map((r) =>
          this.applyPendingUnread(
            buildRoomSummary(r, accountId, userByRoom.get(r.roomId)),
          ),
        )
        .sort(compareRoomSummaries),
    );
    this._directRoomIds.set(direct);
    this.dmPeers = new Set(userByRoom.values());
    // Profiles hydrate on sync; see the field's own note on why this is a counter.
    this._profileRevision.update((n) => n + 1);
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

  // `creatorId` is deliberately required rather than defaulted: a second caller that
  // forgot it would compile and silently report `isCreator: false` for everyone, quietly
  // removing the Owner section with no type error to catch it.
  private toMember(
    member: RoomMember,
    creatorId: string | null,
  ): MemberSummary {
    const name = member.name || member.userId;
    return {
      userId: member.userId,
      name,
      initial: initialOf(name),
      avatarMxc: member.getMxcAvatarUrl() ?? null,
      powerLevel: member.powerLevel,
      isCreator: !!creatorId && member.userId === creatorId,
    };
  }
}
