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
  defer,
  from,
  map,
  of,
  switchMap,
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
  initialOf,
  isMarkedUnread,
} from './room-projection';
import { RoomActionPermissionsService } from './room-action-permissions.service';

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

/**
 * The answer for a room with no members to report — an unknown room, or no room at all.
 *
 * Shared and frozen rather than a fresh `[]` per call, so {@link RoomsService.membersFor}'s
 * identity invariant holds on these paths too: a fresh array would re-notify every consumer
 * of the null-room signal on each write, which is the landing state and the state after
 * every `closeOpenRoom()`.
 */
const EMPTY_MEMBERS: readonly MemberSummary[] = Object.freeze([]);
const EMPTY_TYPING: readonly string[] = Object.freeze([]);

/** Whether two typing-name lists say the same thing, in order. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
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
  private readonly actionPermissions = inject(RoomActionPermissionsService);

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
  private readonly onMyMembership = (room?: { roomId?: string }): void => {
    // A room we have left stops syncing, so its members never emit the "stopped typing"
    // transition and its key would sit in the map for the rest of the session — visible
    // again the moment the room is rejoined, and frozen there, because an unchanged set
    // writes nothing.
    const roomId = room?.roomId;
    if (roomId) {
      this.pendingMemberRemovals.delete(roomId);
      this.dirtyTypingRooms.delete(roomId);
      const current = this._typingByRoom();
      if (roomId in current) {
        const next = { ...current };
        delete next[roomId];
        this._typingByRoom.set(next);
      }
    }
    this.scheduleMemberReread(null);
  };

  /** Someone in a room joined, left, or changed their profile. */
  private readonly onMemberChanged = (
    _event: MatrixEvent,
    state: RoomState,
    member: RoomMember,
  ): void => {
    const pending = this.pendingMemberRemovals.get(state.roomId);
    if (pending?.has(member.userId) && member.membership !== 'join') {
      pending.delete(member.userId);
      if (!pending.size) {
        this.pendingMemberRemovals.delete(state.roomId);
      }
    }
    // Dispatched by the room the event happened in. `RoomStateEvent.Members` fans out per
    // member — one `m.room.power_levels` change emits once for every member of the room —
    // and it is unfiltered, so it also fires for rooms nothing is watching.
    this.scheduleMemberReread(state.roomId);
    // A DM peer's profile can arrive or change without a sync — `loadMembersIfNeeded`
    // from opening a member list, say — and their avatar IS the room's picture. Gated
    // on the DM map so a member event in a large room does not rebuild the whole room
    // list, which is exactly why this listener was kept out of the coalesced rebuild.
    if (this.dmPeers.has(member.userId)) {
      this.projection.schedule();
    }
  };

  /**
   * One signal per room whose member list someone has watched — never pruned, because
   * consumers hold the `asReadonly()` handle it returns and dropping the entry would
   * silently detach them. Bounded in practice by rooms opened in one session.
   */
  private readonly memberSignals = new Map<
    string,
    WritableSignal<readonly MemberSummary[]>
  >();

  /** Successful kick/ban writes waiting for their authoritative membership sync echo. */
  private readonly pendingMemberRemovals = new Map<string, Set<string>>();

  /** Rooms whose member list needs re-reading on the next flush. */
  private readonly dirtyMemberRooms = new Set<string>();
  /** Set when an event names no room, so every watched list is re-read. */
  private allMembersDirty = false;

  /**
   * Member re-reads are batched, because `RoomStateEvent.Members` fans out PER MEMBER —
   * `room-state.js` emits it inside a loop, so setting a room's state once emits N times —
   * and each re-read is O(members): `getJoinedMembers()` plus the fingerprint runs before
   * the memo can hit. Un-batched, a bulk membership set is O(members squared) on the main
   * thread. One flush per turn makes it O(members).
   */
  private readonly memberFlusher = coalesce(() => {
    if (this.allMembersDirty) {
      this.allMembersDirty = false;
      this.dirtyMemberRooms.clear();
      this.rereadMembers(null);
      return;
    }
    const rooms = [...this.dirtyMemberRooms];
    this.dirtyMemberRooms.clear();
    for (const roomId of rooms) {
      this.rereadMembers(roomId);
    }
  });

  /** Queue a member re-read; `null` means "every watched room" (the event named none). */
  private scheduleMemberReread(roomId: string | null): void {
    if (roomId === null) {
      this.allMembersDirty = true;
    } else if (this.memberSignals.has(roomId)) {
      this.dirtyMemberRooms.add(roomId);
    } else {
      return; // nothing watching that room — do not wake the flusher for it
    }
    this.memberFlusher.schedule();
  }

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

  /**
   * Remove a successfully moderated member from the live roster before the sync echo.
   *
   * Matrix moderation requests resolve after the homeserver accepts the write, while the
   * SDK-owned room state changes only when `/sync` returns the membership event. The member
   * panel closes as soon as the request succeeds, so leaving the projection untouched makes
   * the reopened roster briefly show the removed member. This updates only Trinity's view;
   * the normal member event remains authoritative and re-reads the SDK state afterward.
   */
  removeMemberFromProjection(roomId: string, userId: string): void {
    // The authoritative membership event can beat the HTTP response back to us. Only
    // create a tombstone while the SDK still reports the member as joined; otherwise a
    // late response would hide a legitimate later rejoin forever because there is no
    // second non-join event left to clear it.
    const room = this.matrix.isInitialized
      ? this.matrix.instance.getRoom(roomId)
      : null;
    const stillJoined = room
      ?.getJoinedMembers()
      .some((member) => member.userId === userId);
    if (stillJoined) {
      const pending =
        this.pendingMemberRemovals.get(roomId) ?? new Set<string>();
      pending.add(userId);
      this.pendingMemberRemovals.set(roomId, pending);
    }

    const members = this.memberSignals.get(roomId);
    if (!members) {
      return;
    }
    const current = members();
    const next = current.filter((member) => member.userId !== userId);
    if (next.length !== current.length) {
      members.set(next);
    }
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
   * Coalesced, and deliberately its own flusher rather than either existing one.
   *
   * `memberFlusher` is gated on `memberSignals.has(roomId)` — it only serves rooms someone
   * is watching — and adding `RoomMemberEvent.Typing` to the projection's `events` list
   * would run a full room-list rebuild and re-sort on every typing EDU from every room.
   * This writes one key.
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
   * One active-Account Projection Runtime entry: {@link projectFromClient} owns listener
   * identity, coalescing, switching, and acknowledgement; only event list and rebuild stay here.
   */
  private readonly projection = projectFromClient({
    id: 'rooms.list',
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
    rebuild: (client) => {
      this.refresh();
      // Only when the client itself changed — a re-login or an account switch. The member
      // signals hold values read from the OUTGOING client, and nothing else re-reads them:
      // their writers are bound to the active client only.
      if (client !== this.lastMemberClient) {
        this.lastMemberClient = client;
        this.rereadMembers(null);
      }
    },
    // Bound by hand rather than added to `events` because these must NOT be coalesced
    // into the rebuild: they feed the per-room member signals alone, which is what keeps a
    // member list reactive without re-running the room-list rebuild on every sync tick.
    // RoomState.members and MyMembership are what change who is in a room (or their
    // profile), and `onMemberChanged` needs the event's arguments to know WHICH room.
    bind: (client) => {
      client.on(RoomStateEvent.Members, this.onMemberChanged);
      client.on(RoomEvent.MyMembership, this.onMyMembership);
      client.on(RoomMemberEvent.Typing, this.onTypingChanged);
    },
    unbind: (client) => {
      client.off(RoomStateEvent.Members, this.onMemberChanged);
      client.off(RoomEvent.MyMembership, this.onMyMembership);
      client.off(RoomMemberEvent.Typing, this.onTypingChanged);
    },
    reset: () => {
      this.memberCache.clear();
      this._rooms.set([]);
      this._directRoomIds.set(new Set());
      this.dmPeers = new Set();
      // A flush queued before the disconnect would otherwise run after this and repopulate
      // from the OUTGOING client — the stale-list-survives-a-switch bug the loop below
      // exists to prevent, reintroduced a microtask late. `projectFromClient` cancels its
      // own coalescer for exactly this reason; it cannot know about this one.
      this.memberFlusher.cancel();
      this.pendingMemberRemovals.clear();
      // The typing map is protected one layer earlier too: its flusher reads
      // `projection.client()` and returns when there is none, so a late flush cannot
      // repopulate from the OUTGOING client the way `memberFlusher` could. Cancelling is
      // kept for symmetry and to skip a pointless microtask — measured, removing it reds
      // nothing on its own. What the suite does pin is the outcome: the map is empty and
      // the listener detached after a disconnect.
      this.typingFlusher.cancel();
      this.dirtyTypingRooms.clear();
      this._typingByRoom.set({});
      // The member signals are part of the read model too. Leaving them holding the
      // outgoing client's members is what makes a stale list survive a switch. The shared
      // empty list, not a fresh `[]`, or every disconnect re-notifies every consumer.
      for (const members of this.memberSignals.values()) {
        members.set(EMPTY_MEMBERS);
      }
    },
  });

  /**
   * The client the member signals were last read against.
   *
   * They are values, not lazy reads, so a new client has to re-read them — and only a NEW
   * client, because `rebuild` also runs on every coalesced sync and re-reading every
   * watched room there would undo the point of dispatching on `state.roomId`.
   */
  private lastMemberClient: MatrixClient | null = null;

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
  membersOf(roomId: string | null): readonly MemberSummary[] {
    if (!roomId || !this.matrix.isInitialized) {
      return EMPTY_MEMBERS;
    }
    const room = this.matrix.instance.getRoom(roomId);
    if (!room) {
      return EMPTY_MEMBERS;
    }
    const pendingRemovals = this.pendingMemberRemovals.get(roomId);
    const joined = pendingRemovals?.size
      ? room
          .getJoinedMembers()
          .filter((member) => !pendingRemovals.has(member.userId))
      : room.getJoinedMembers();
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
      this.actionPermissions.assert(this.actionPermissions.room(roomId).invite);
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
