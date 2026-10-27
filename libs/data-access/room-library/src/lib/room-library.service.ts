import { Injectable, computed, inject, signal, untracked } from '@angular/core';
import {
  ClientEvent,
  EventType,
  HistoryVisibility,
  MatrixEventEvent,
  Preset,
  ReceiptType,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  MatrixError,
  type EventTimeline,
  type MatrixClient,
  type MatrixEvent,
  type Room,
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
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import { PrivacySettingsService } from '@trinity/platform-native';
import {
  RoomEncryptionFlags,
  isValidUserId,
  roomEncryptionInitialState,
  type UnencryptedMark,
} from '@trinity/util/matrix';
import { compareRoomSummaries } from './room-projection';
import {
  buildRoomSummary,
  directMapOf,
  isMarkedUnread,
} from './js-sdk/room-info';
import {
  ROOM_LIBRARY_GOVERNANCE_POLICY,
  assertRoomLibraryGovernance,
  type RoomLibraryGovernanceKey,
} from './room-library-governance-policy';
import {
  addToDirectMap,
  createEncryptedRoom,
  existingDirectRoom,
} from './js-sdk/direct-rooms';
import { RoomTyping } from './room-typing';

/** Fields a {@link RoomLibraryService.createRoom} call accepts. */
export interface CreateRoomOptions {
  name: string;
  topic?: string;
  /** Public (discoverable + publicly joinable) vs the default invite-only room. */
  isPublic?: boolean;
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
  /** The not-encrypted mark for {@link lastMessage}, or null when it needs none. */
  lastMessageMark: UnencryptedMark | null;
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
 * `next`, or `previous` when it describes the room identically.
 *
 * Every sync rebuilds every joined room's summary. Handing back the previous object for a room
 * the sync didn't change keeps its OnPush sidebar row from re-rendering, and lets
 * {@link sameRooms} keep the whole list when no room changed at all.
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

/** The invitee blocks invites (MSC4380), so the invite was refused. Carries no user copy. */
export class InviteBlockedError extends Error {
  constructor(readonly userId: string) {
    super('M_INVITE_BLOCKED');
    this.name = 'InviteBlockedError';
  }
}

const INVITE_BLOCKED_ERRCODES = new Set([
  'M_INVITE_BLOCKED',
  'ORG.MATRIX.MSC4155.INVITE_BLOCKED',
]);

function isInviteBlocked(error: unknown): boolean {
  return (
    error instanceof MatrixError &&
    INVITE_BLOCKED_ERRCODES.has(error.errcode ?? '')
  );
}

/**
 * Which earlier messages an invitee will be able to read in an encrypted room: everything the
 * room shares (when the inviter's device can share it), or only from their invite or join on.
 */
export type InviteHistory = 'shared' | 'from-invite' | 'from-join';

/**
 * Read model over the synced `MatrixClient`: joined rooms as plain view models (components
 * never touch `matrix-js-sdk`), recomputed as the client syncs; Application Runtime retains the
 * projection lifetime. Space rooms are excluded from {@link rooms}; spaces are a separate read
 * model ({@link SpacesService}).
 */
@Injectable({ providedIn: 'root' })
export class RoomLibraryService {
  private readonly matrix = inject(MatrixClientService);
  private readonly privacy = inject(PrivacySettingsService);
  private readonly governance = inject(ROOM_LIBRARY_GOVERNANCE_POLICY);

  /**
   * The other party in each of our DMs, refreshed by {@link refresh}. A DM has no
   * `m.room.avatar`, so its row's picture comes from this member, which makes the room list
   * depend on member state.
   */
  private dmPeers: ReadonlySet<string> = new Set();

  /**
   * Marked-unread writes shown before /sync confirms them, keyed by room id. An entry is dropped
   * once the synced room agrees, so this holds only in-flight state rather than shadowing the
   * server.
   */
  private readonly pendingUnread = new Map<string, boolean>();
  /** Room lock marks: the room state, or else the active Account's crypto store. */
  private encryption = new RoomEncryptionFlags();

  private readonly typing = new RoomTyping(() => this.projection.client());

  /** Someone in a room joined, left, or changed their profile. */
  private readonly onMemberChanged = (
    _event: MatrixEvent,
    state: RoomState,
    member: RoomMember,
  ): void => {
    void state;
    // A DM peer's profile can arrive or change without a sync (`loadMembersIfNeeded` from opening
    // a member list) and their avatar IS the room's picture. Gated on the DM map so a member
    // event in a large room does not rebuild the whole list, which is why this listener stays
    // out of the coalesced rebuild.
    if (this.dmPeers.has(member.userId)) {
      this.projection.schedule();
    }
  };

  /**
   * The live timeline each row was built from, or null when it was empty. The list does not
   * rebuild on every timeline event, so a row is re-read when history pages into a room
   * whose timeline was empty or has been replaced since (a rewind after an unblock), or its
   * preview and order would stay as they were until the next sync.
   */
  private builtFrom = new Map<string, EventTimeline | null>();
  private readonly onPagedIn = (
    _event: MatrixEvent | undefined,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined,
  ): void => {
    if (
      toStartOfTimeline &&
      room &&
      this.builtFrom.has(room.roomId) &&
      this.builtFrom.get(room.roomId) !== room.getLiveTimeline()
    ) {
      this.projection.schedule();
    }
  };

  /** Who is typing, per room; see {@link RoomTyping.typingByRoom}. */
  readonly typingByRoom = this.typing.typingByRoom;

  private readonly _rooms = signal<RoomSummary[]>([], { equal: sameRooms });
  readonly rooms = this._rooms.asReadonly();

  /**
   * App-wide unread total: the sum of every joined room's unread notification count (the
   * app-icon badge; see AppBadgeService).
   */
  readonly totalUnread = computed(() =>
    this.rooms().reduce((sum, r) => sum + r.unreadCount, 0),
  );

  /**
   * Room ids the `m.direct` account-data map records as direct messages, recomputed on each
   * {@link refresh}, so read-only consumers can tag a joined room as a DM without re-reading
   * account data. Non-authoritative for membership: a DM we have left still appears here until
   * the map is rewritten.
   */
  private readonly _directRoomIds = signal<ReadonlySet<string>>(new Set());
  readonly directRoomIds = this._directRoomIds.asReadonly();

  /**
   * Active-Account Projection Runtime entry: {@link projectFromClient} owns listener identity,
   * coalescing, switching and acknowledgement; only the event list and rebuild stay here.
   */
  private readonly projection = projectFromClient({
    id: 'rooms.list',
    matrix: this.matrix,
    events: [
      ClientEvent.Sync,
      ClientEvent.Room,
      RoomEvent.Name,
      RoomEvent.MyMembership,
      // Keep unread badges live. In an encrypted room the notification count is only recomputed
      // once the message DECRYPTS (async), after the Sync that carried the ciphertext, so Sync
      // alone drops those increments. Decrypted (re-emitted at the client) fires then. Receipt
      // fires when a room is read and its count clears. (UnreadNotifications is Room-only, not
      // re-emitted here.)
      MatrixEventEvent.Decrypted,
      RoomEvent.Receipt,
      // Room tags (e.g. `m.favourite`, the favourite flag) can change from another device;
      // rebuild so a remote favourite/unfavourite re-partitions and re-sorts the list live.
      RoomEvent.Tags,
      // Room account data carries the marked-unread flag; without it a room flagged on another
      // device would not surface until an unrelated event rebuilt the list.
      RoomEvent.AccountData,
    ],
    rebuild: () => this.refresh(),
    // Bound by hand because typing has its own per-Room coalescer and member changes only
    // rebuild the Room list when a DM peer's profile affects its summary. Room
    // Administration owns the member-roster projection itself.
    bind: (client) => {
      client.on(RoomEvent.Timeline, this.onPagedIn);
      client.on(RoomStateEvent.Members, this.onMemberChanged);
      client.on(RoomEvent.MyMembership, this.typing.onMyMembership);
      client.on(RoomMemberEvent.Typing, this.typing.onTypingChanged);
    },
    unbind: (client) => {
      client.off(RoomEvent.Timeline, this.onPagedIn);
      client.off(RoomStateEvent.Members, this.onMemberChanged);
      client.off(RoomEvent.MyMembership, this.typing.onMyMembership);
      client.off(RoomMemberEvent.Typing, this.typing.onTypingChanged);
    },
    reset: () => {
      this.encryption = new RoomEncryptionFlags();
      this._rooms.set([]);
      this.builtFrom = new Map();
      this._directRoomIds.set(new Set());
      this.dmPeers = new Set();
      this.typing.reset();
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
   * Favourite (or unfavourite) a room via the standard `m.favourite` room tag, persisted in
   * account data and synced across devices (interops with Element). Cold; errors reach the
   * subscriber. The post-write {@link refresh} lands the change locally and the
   * `RoomEvent.Tags` listener reconciles the sync echo.
   */
  setFavourite(
    roomId: string,
    favourite: boolean,
    accountId?: string,
  ): Observable<void> {
    return this.setTag(roomId, 'm.favourite', favourite, accountId);
  }

  /**
   * Add or remove the room's `m.lowpriority` tag, on the account that owns the row. Same cold
   * finite shape as {@link setFavourite}. The tag body is empty: Matrix tags carry an optional
   * `order` that Trinity does not use, since ordering within the group comes from the sort mode.
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
        tap(() => this.refresh()),
        map(() => void 0),
      );
    });
  }

  /**
   * Leave a joined room. Cold. The resulting `RoomEvent.MyMembership` drops the room from
   * {@link rooms} (filtered to `join`), so no explicit refresh is needed; errors reach the
   * subscriber.
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
   * The client that owns a row's room: the named account's (mixed-account view, where a row may
   * belong to a non-active account), else the active client. Null when there is none; the
   * caller decides whether that is a silent no-op or an error.
   */
  private clientOwning(accountId?: string): MatrixClient | null {
    if (accountId) {
      return this.matrix.clientFor(accountId);
    }
    return this.matrix.isInitialized ? this.matrix.instance : null;
  }

  /**
   * Mark a room read: ack its latest confirmed event with a read receipt and fully-read marker.
   * Cold; a no-op for an empty or unknown room. The client emits the receipt so {@link rooms}
   * re-derives the badge.
   */
  markRead(roomId: string, accountId?: string): Observable<void> {
    return defer(() => {
      const client = this.clientOwning(accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      const room = client.getRoom(roomId);
      const events = room?.getLiveTimeline().getEvents() ?? [];
      // Walk backward for the newest confirmed (non-local-echo) event; no array copy, since the
      // caller runs this per unread room.
      let latest: (typeof events)[number] | undefined;
      for (let i = events.length - 1; i >= 0; i--) {
        if (!events[i].status) {
          latest = events[i];
          break;
        }
      }
      // Clear the flag first, and unconditionally: an empty room returns early below, but a
      // room flagged unread and then marked read must stop being flagged either way.
      const latestId = latest?.getId();
      if (!latest || !latestId) {
        return this.clearMarkedUnreadOn(roomId, accountId);
      }
      // Honor the read-receipt privacy setting: when off, ack privately (`m.read.private`) so
      // the badge clears without telling other members. Keep in step with
      // TimelineService.markRead.
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
   * Room account data, so it syncs to other devices and interops with Element. The read
   * receipt is deliberately untouched: the flag says "I have seen this and still want it in
   * front of me", which a receipt cannot express. Clearing writes `{unread: false}` rather
   * than redacting, which is what other clients read back.
   *
   * Cold and finite like {@link setFavourite}: the optimistic {@link refresh} lands the change
   * at once, the `RoomEvent.AccountData` listener covers the echo, and a write failure rolls
   * the overlay back.
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
      // Shown before the server confirms: `setRoomAccountData` is a bare PUT with no local echo
      // and `Room.accountData` is only written from /sync, so a post-write refresh alone
      // re-reads the OLD value.
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
   * Sweeps every signed-in account: a row merged from two mixed accounts can be flagged on
   * either, and clearing only the active one would leave the row reading as unread. Writes
   * nothing for an account that does not hold the flag, so it is cheap on every room open.
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
   * The single definition of "clear the flag", shared by {@link clearMarkedUnread} and
   * {@link markRead} so the two cannot drift; checking first keeps it cheap on every room open.
   * Cold and finite: a failed clear reaches the owning workflow, which may suppress room-open
   * failures.
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
   * {@link SpacesService.createRoomInSpace} it carries `m.room.encryption` (Megolm) in its
   * `initial_state`, so it is encrypted from the first event. It surfaces in {@link rooms}
   * once the client syncs it. Cold.
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
   * Resolve a room id or alias to a room id: a `!id:hs` resolves immediately, a `#alias:hs` is
   * looked up on the homeserver. Cold. Routes `matrix.to` room permalinks, which may carry
   * either form.
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
   * A DM that `m.direct` records with this user and that we have not left is reused, so
   * repeated "message" actions don't spawn duplicates. Otherwise a new invite-only, encrypted
   * room is created (`is_direct`, `trusted_private_chat` preset, the user invited, Megolm
   * enabled) and registered in `m.direct` so both ends and future reuse treat it as a DM.
   * Rejects when `userId` isn't a valid MXID. Cold.
   */
  createDirectMessage(userId: string): Observable<string> {
    return defer(() => {
      if (!isValidUserId(userId)) {
        return throwError(() => new Error(`Invalid user id: ${userId}`));
      }
      const client = this.matrix.instance;
      const existing = existingDirectRoom(client, userId);
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
          addToDirectMap(client, userId, res.room_id).pipe(
            map(() => res.room_id),
          ),
        ),
      );
    });
  }

  /**
   * Invite `userId` to `roomId`, a room or a space alike. Rejects when `userId` isn't a valid
   * MXID. Cold.
   */
  inviteUser(
    target: string | RoomLibraryGovernanceKey,
    userId: string,
  ): Observable<void> {
    return defer(() => {
      if (!isValidUserId(userId)) {
        return throwError(() => new Error(`Invalid user id: ${userId}`));
      }
      const client = this.clientForTarget(target);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      const accountId = client.getUserId();
      if (!accountId) return throwError(() => new Error('Not signed in.'));
      const roomId = typeof target === 'string' ? target : target.roomId;
      assertRoomLibraryGovernance(
        this.governance.authorize({ accountId, roomId }, 'invite'),
      );
      return from(client.invite(roomId, userId)).pipe(
        map(() => void 0),
        catchError((error: unknown) =>
          throwError(() =>
            isInviteBlocked(error) ? new InviteBlockedError(userId) : error,
          ),
        ),
      );
    });
  }

  /**
   * What someone invited to `target` now will be able to read, or null for an unencrypted or
   * unknown room. A synchronous read for the invite dialog's note.
   */
  inviteHistory(
    target: string | RoomLibraryGovernanceKey,
  ): InviteHistory | null {
    const roomId = typeof target === 'string' ? target : target.roomId;
    const room = this.clientForTarget(target)?.getRoom(roomId);
    if (!room?.hasEncryptionStateEvent()) return null;
    switch (room.getHistoryVisibility()) {
      case HistoryVisibility.Invited:
        return 'from-invite';
      case HistoryVisibility.Joined:
        return 'from-join';
      default:
        return 'shared';
    }
  }

  /** The active client for a bare room id, else the key's exact account. */
  private clientForTarget(
    target: string | RoomLibraryGovernanceKey,
  ): MatrixClient | null {
    if (typeof target !== 'string')
      return this.matrix.clientFor(target.accountId);
    return this.matrix.isInitialized ? this.matrix.instance : null;
  }

  private refresh(): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    const client = this.matrix.instance;
    const accountId = this.matrix.activeUserId() ?? client.getUserId?.() ?? '';
    const { ids: direct, userByRoom } = directMapOf(client);

    const previous = new Map(
      untracked(this._rooms).map((room) => [room.id, room] as const),
    );
    const encryption = this.encryption;
    const crypto = client.getCrypto?.();
    // Spaces are rendered in the server rail, not as channels in the room list.
    const joined = client
      .getRooms()
      .filter((r) => !r.isSpaceRoom() && r.getMyMembership() === 'join');
    this._rooms.set(
      joined
        .map((r) =>
          reuseUnchanged(
            previous.get(r.roomId),
            this.applyPendingUnread(
              buildRoomSummary(
                r,
                accountId,
                userByRoom.get(r.roomId),
                encryption,
                !!crypto,
              ),
            ),
          ),
        )
        .sort(compareRoomSummaries),
    );
    for (const room of joined) {
      if (room.hasEncryptionStateEvent() || encryption.answered(room.roomId)) {
        continue;
      }
      // Any answer can change the row: the lock, or a preview held back until now.
      void encryption.refresh(crypto, room.roomId).then(() => {
        if (
          encryption.answered(room.roomId) &&
          this.encryption === encryption
        ) {
          this.projection.schedule();
        }
      });
    }
    this.builtFrom = new Map(
      joined.map((room) => {
        const timeline = room.getLiveTimeline();
        return [room.roomId, timeline.getEvents().length ? timeline : null];
      }),
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
}
