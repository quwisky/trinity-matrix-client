import {
  Injectable,
  type Signal,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import {
  NEVER,
  Observable,
  catchError,
  concat,
  defer,
  forkJoin,
  map,
  of,
  throwError,
  type OperatorFunction,
} from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { PrivacySettingsService } from '@trinity/platform-native';
import {
  isValidUserId,
  plainEqual,
  unwrapEngineResult,
  type EngineResult,
  type UnencryptedMark,
} from '@trinity/util/matrix';
import { compareRoomSummaries, roomSummaryOf } from './room-projection';
import {
  ROOM_LIBRARY_GOVERNANCE_POLICY,
  assertRoomLibraryGovernance,
  type RoomLibraryGovernanceKey,
} from './room-library-governance-policy';
import type {
  CreateRoomRequest,
  RoomInfo,
  TypingMember,
} from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { RoomListStore } from './room-list-store';

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

interface RoomListSource {
  readonly accountId: string;
  readonly rows: readonly RoomInfo[];
  readonly pending: ReadonlyMap<string, boolean>;
}

interface TypingSource {
  readonly typing: Readonly<Record<string, readonly TypingMember[]>>;
  readonly selves: readonly string[];
}

/** The invitee blocks invites (MSC4380), so the invite was refused. Carries no user copy. */
export class InviteBlockedError extends Error {
  constructor(readonly userId: string) {
    super('M_INVITE_BLOCKED');
    this.name = 'InviteBlockedError';
  }
}

/**
 * Which earlier messages an invitee will be able to read in an encrypted room: everything the
 * room shares (when the inviter's device can share it), or only from their invite or join on.
 */
export type InviteHistory = 'shared' | 'from-invite' | 'from-join';

/**
 * Read model over the active Account's room list: joined rooms as plain view models (components
 * never touch `matrix-js-sdk`), derived from {@link RoomListStore}. Space rooms are excluded from
 * {@link rooms}; spaces are a separate read model ({@link SpacesService}).
 */
@Injectable({ providedIn: 'root' })
export class RoomLibraryService {
  private readonly engine = inject(ROOM_LIST_ENGINE);
  private readonly store = inject(RoomListStore);
  private readonly session = inject(SessionStateService);
  private readonly privacy = inject(PrivacySettingsService);
  private readonly governance = inject(ROOM_LIBRARY_GOVERNANCE_POLICY);

  /**
   * Marked-unread writes shown before the room list confirms them, keyed by room id. An entry
   * is dropped once the listed room agrees, so this holds only in-flight state rather than
   * shadowing the server.
   */
  private readonly pendingUnread = signal<ReadonlyMap<string, boolean>>(
    new Map(),
  );

  /** The active Account's listed rooms, or none while no Account is active. */
  private readonly activeRows = computed((): readonly RoomInfo[] => {
    const accountId = this.session.activeAccountId();
    return accountId ? this.store.rooms(accountId)() : [];
  });

  readonly rooms: Signal<RoomSummary[]> = linkedSignal<
    RoomListSource,
    RoomSummary[]
  >({
    source: () => ({
      accountId: this.session.activeAccountId() ?? '',
      rows: this.activeRows(),
      pending: this.pendingUnread(),
    }),
    computation: ({ accountId, rows, pending }, previous): RoomSummary[] => {
      const kept = new Map(
        (previous?.value ?? []).map((room) => [room.id, room] as const),
      );
      // Spaces are rendered in the server rail, not as channels in the room list.
      return rows
        .filter((info) => info.membership === 'join' && !info.isSpace)
        .map((info) =>
          reuseUnchanged(
            kept.get(info.roomId),
            withPendingUnread(roomSummaryOf(accountId, info), pending),
          ),
        )
        .sort(compareRoomSummaries);
    },
    equal: sameRooms,
  }).asReadonly();

  /**
   * App-wide unread total: the sum of every joined room's unread notification count (the
   * app-icon badge; see AppBadgeService).
   */
  readonly totalUnread = computed(() =>
    this.rooms().reduce((sum, r) => sum + r.unreadCount, 0),
  );

  /**
   * Who is typing, per room, by display name: the sidebar's source. Every signed-in account is
   * left out, not just the active one: a room both accounts are joined to renders as ONE row
   * (see `RoomSummary.accountIds`), so the other account must not announce itself there.
   */
  readonly typingByRoom: Signal<Record<string, readonly string[]>> =
    linkedSignal<TypingSource, Record<string, readonly string[]>>({
      source: () => {
        const accountId = this.session.activeAccountId();
        return {
          typing: accountId ? this.store.typing(accountId)() : {},
          selves: this.session.accountIds(),
        };
      },
      computation: (
        { typing, selves },
        previous,
      ): Record<string, readonly string[]> => {
        const own = new Set(selves);
        const byRoom: Record<string, readonly string[]> = {};
        for (const [roomId, members] of Object.entries(typing)) {
          const names = members
            .filter((member) => !own.has(member.userId))
            .map((member) => member.displayName);
          if (!names.length) continue;
          // Each sidebar row binds its own room's list, so an unchanged one keeps its reference.
          const before = previous?.value[roomId];
          byRoom[roomId] = before && plainEqual(before, names) ? before : names;
        }
        return byRoom;
      },
      equal: plainEqual,
    }).asReadonly();

  /**
   * Room ids the `m.direct` account-data map records as direct messages, so read-only consumers
   * can tag a joined room as a DM without re-reading account data. Non-authoritative for
   * membership: a DM we have left still appears here until the map is rewritten.
   */
  readonly directRoomIds = computed((): ReadonlySet<string> => {
    const accountId = this.session.activeAccountId();
    return new Set(
      accountId ? Object.values(this.store.directMap(accountId)()).flat() : [],
    );
  });

  constructor() {
    // Hands each confirmed flag back to the server as the list changes, not when it is read.
    effect(() => {
      const pending = this.pendingUnread();
      if (!pending.size) return;
      const rows = new Map(this.activeRows().map((row) => [row.roomId, row]));
      const open = new Map(
        [...pending].filter(
          ([roomId, unread]) => rows.get(roomId)?.markedUnread !== unread,
        ),
      );
      if (open.size !== pending.size) this.pendingUnread.set(open);
    });
  }

  /**
   * Retained by the Room Library session lifetime. The store keeps each live Account's room
   * list itself, so this only acknowledges at once.
   */
  runProjection(): Observable<void> {
    return concat(of(undefined), NEVER);
  }

  /**
   * Whether Workspace may select this Room. `unconfirmed`: the Account is live and the id is
   * well-formed, but its room list does not hold the Room (yet) — the Conversation decides
   * (pending before sync, unavailable after). `unavailable`: never navigate here.
   */
  selectionAvailability(
    accountId: string,
    roomId: string,
  ): RoomLibrarySelectionAvailability {
    if (!this.isLive(accountId) || !roomId.startsWith('!')) {
      return 'unavailable';
    }
    return this.store.room(accountId, roomId) ? 'available' : 'unconfirmed';
  }

  /**
   * Read the standard Room tags for one exact Account-and-Room selection.
   *
   * `null` means that exact Account or joined Room is unavailable; callers must not
   * substitute a merged sidebar row or an active-Account default.
   */
  organisationFor(
    accountId: string,
    roomId: string,
  ): RoomOrganisationSnapshot | null {
    const room = this.store.room(accountId, roomId);
    if (room?.membership !== 'join') {
      return null;
    }
    return { favourite: room.favourite, lowPriority: room.lowPriority };
  }

  /**
   * Favourite (or unfavourite) a room via the standard `m.favourite` room tag, persisted in
   * account data and synced across devices (interops with Element). Cold; errors reach the
   * subscriber.
   */
  setFavourite(
    roomId: string,
    favourite: boolean,
    accountId?: string,
  ): Observable<void> {
    return this.setTag(roomId, 'favourite', favourite, accountId);
  }

  /**
   * Add or remove the room's `m.lowpriority` tag, on the account that owns the row. Same cold
   * finite shape as {@link setFavourite}.
   */
  setLowPriority(
    roomId: string,
    lowPriority: boolean,
    accountId?: string,
  ): Observable<void> {
    return this.setTag(roomId, 'lowPriority', lowPriority, accountId);
  }

  private setTag(
    roomId: string,
    tag: 'favourite' | 'lowPriority',
    enabled: boolean,
    accountId?: string,
  ): Observable<void> {
    return this.command(accountId, (owner) =>
      this.engine.setTag(owner, roomId, tag, enabled),
    ).pipe(map(() => void 0));
  }

  /**
   * Leave a joined room. Cold. The room drops from {@link rooms} (filtered to `join`); errors
   * reach the subscriber.
   */
  leave(roomId: string, accountId?: string): Observable<void> {
    return this.command(accountId, (owner) =>
      this.engine.leave(owner, roomId),
    ).pipe(map(() => void 0));
  }

  /**
   * Mark a room read: ack its latest confirmed event with a read receipt and fully-read marker,
   * and drop its marked-unread flag. Cold; a no-op for an empty or unknown room.
   */
  markRead(roomId: string, accountId?: string): Observable<void> {
    return defer(() => {
      const owner = this.owning(accountId);
      if (!owner) {
        return throwError(() => new Error('Not signed in.'));
      }
      const flagged = this.store.room(owner, roomId)?.markedUnread === true;
      if (flagged) this.showPendingUnread(roomId, false);
      // Honor the read-receipt privacy setting: when off, ack privately so the badge clears
      // without telling other members. Keep in step with TimelineService.markRead.
      const receipts = this.privacy.sendReadReceipts() ? 'public' : 'private';
      return this.engine.markRead(owner, roomId, receipts).pipe(
        unwrapOwned(),
        map(() => void 0),
        catchError((error: unknown) => {
          if (flagged) this.forgetPendingUnread(roomId);
          return throwError(() => error);
        }),
      );
    });
  }

  /**
   * Flag a room to come back to, or clear that flag (`m.marked_unread`, MSC2867).
   *
   * Room account data, so it syncs to other devices and interops with Element. The read
   * receipt is deliberately untouched: the flag says "I have seen this and still want it in
   * front of me", which a receipt cannot express.
   *
   * Cold and finite like {@link setFavourite}: the optimistic overlay lands the change at
   * once, the room list confirms it, and a write failure rolls the overlay back.
   */
  setMarkedUnread(
    roomId: string,
    unread: boolean,
    accountId?: string,
  ): Observable<void> {
    return defer(() => {
      const owner = this.owning(accountId);
      if (!owner) {
        return throwError(() => new Error('Not signed in.'));
      }
      // The write has no local echo: the room list changes only once /sync returns it.
      this.showPendingUnread(roomId, unread);
      return this.engine.setMarkedUnread(owner, roomId, unread).pipe(
        unwrapOwned(),
        map(() => void 0),
        catchError((error: unknown) => {
          this.forgetPendingUnread(roomId); // put the row back
          return throwError(() => error);
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
      const clears = this.session
        .accountIds()
        .map((accountId) => this.clearMarkedUnreadOn(roomId, accountId));
      return clears.length
        ? forkJoin(clears).pipe(map(() => void 0))
        : of(void 0);
    });
  }

  /** Drop the flag on ONE account, and only if it is actually set. */
  private clearMarkedUnreadOn(
    roomId: string,
    accountId: string,
  ): Observable<void> {
    return defer(() =>
      this.store.room(accountId, roomId)?.markedUnread
        ? this.setMarkedUnread(roomId, false, accountId)
        : of(void 0),
    );
  }

  /**
   * Create a standalone (not space-linked) E2EE room and resolve its room id. Like
   * {@link SpacesService.createRoomInSpace} it carries `m.room.encryption` (Megolm) in its
   * `initial_state`, so it is encrypted from the first event. Cold.
   */
  createRoom(options: CreateRoomOptions): Observable<string> {
    return this.command(undefined, (owner) =>
      this.engine.createRoom(owner, createRequestOf(options)),
    ).pipe(map(({ roomId }) => roomId));
  }

  /** Create an encrypted Room on one immutable Account, independent of later activation. */
  createRoomFor(
    accountId: string,
    options: CreateRoomOptions,
  ): Observable<string> {
    return defer(() =>
      this.isLive(accountId)
        ? this.engine.createRoom(accountId, createRequestOf(options)).pipe(
            unwrapOwned('Account unavailable.'),
            map(({ roomId }) => roomId),
          )
        : throwError(() => new Error('Account unavailable.')),
    );
  }

  /**
   * Resolve a room id or alias to a room id: a `!id:hs` resolves immediately, a `#alias:hs` is
   * looked up on the homeserver. Cold. Routes `matrix.to` room permalinks, which may carry
   * either form.
   */
  resolveRoomId(roomIdOrAlias: string): Observable<string> {
    return defer(() =>
      roomIdOrAlias.startsWith('!')
        ? of(roomIdOrAlias)
        : this.command(undefined, (owner) =>
            this.engine.resolveAlias(owner, roomIdOrAlias),
          ).pipe(map(({ roomId }) => roomId)),
    );
  }

  /**
   * Open (or reuse) a 1:1 direct message with `userId` and resolve its room id. Rejects when
   * `userId` isn't a valid MXID. Cold.
   */
  createDirectMessage(userId: string): Observable<string> {
    return defer(() =>
      isValidUserId(userId)
        ? this.command(undefined, (owner) =>
            this.engine.createDirectMessage(owner, userId),
          ).pipe(map(({ roomId }) => roomId))
        : throwError(() => new Error(`Invalid user id: ${userId}`)),
    );
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
      const accountId = this.accountForTarget(target);
      if (!accountId) {
        return throwError(() => new Error('Not signed in.'));
      }
      const roomId = typeof target === 'string' ? target : target.roomId;
      assertRoomLibraryGovernance(
        this.governance.authorize({ accountId, roomId }, 'invite'),
      );
      return this.engine.invite(accountId, roomId, userId).pipe(
        map((result) => {
          if (!result.ok && result.failure.code === 'invite-blocked') {
            throw new InviteBlockedError(userId);
          }
          return result;
        }),
        unwrapOwned(),
        map(() => void 0),
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
    const accountId = this.accountForTarget(target);
    const roomId = typeof target === 'string' ? target : target.roomId;
    const room = accountId ? this.store.room(accountId, roomId) : null;
    if (room?.encryption !== 'encrypted') return null;
    switch (room.historyVisibility) {
      case 'invited':
        return 'from-invite';
      case 'joined':
        return 'from-join';
      default:
        return 'shared';
    }
  }

  /** The active Account for a bare room id, else the key's exact Account; null when not live. */
  private accountForTarget(
    target: string | RoomLibraryGovernanceKey,
  ): string | null {
    return this.owning(
      typeof target === 'string' ? undefined : target.accountId,
    );
  }

  /**
   * The Account that owns a row's room: the named one (mixed-account view, where a row may
   * belong to a non-active Account), else the active one. Null when that Account is not live.
   */
  private owning(accountId?: string): string | null {
    const owner = accountId ?? this.session.activeAccountId();
    return owner && this.isLive(owner) ? owner : null;
  }

  private isLive(accountId: string): boolean {
    return this.session.accountIds().includes(accountId);
  }

  /** A cold engine command on the owning Account, rejecting with "Not signed in." without one. */
  private command<T>(
    accountId: string | undefined,
    run: (owner: string) => Observable<EngineResult<T>>,
  ): Observable<T> {
    return defer(() => {
      const owner = this.owning(accountId);
      return owner
        ? run(owner).pipe(unwrapOwned<T>())
        : throwError(() => new Error('Not signed in.'));
    });
  }

  private showPendingUnread(roomId: string, unread: boolean): void {
    this.pendingUnread.update((pending) =>
      new Map(pending).set(roomId, unread),
    );
  }

  private forgetPendingUnread(roomId: string): void {
    this.pendingUnread.update((pending) => {
      const next = new Map(pending);
      next.delete(roomId);
      return next;
    });
  }
}

/** `summary` with an in-flight marked-unread write overlaid, while one differs from it. */
function withPendingUnread(
  summary: RoomSummary,
  pendingUnread: ReadonlyMap<string, boolean>,
): RoomSummary {
  const pending = pendingUnread.get(summary.id);
  if (pending === undefined || pending === summary.markedUnread) {
    return summary;
  }
  return {
    ...summary,
    markedUnread: pending,
    hasUnread: summary.unreadCount > 0 || pending,
  };
}

/** {@link unwrapEngineResult}, with an Account that stopped being live failing as the guards do. */
function unwrapOwned<T>(
  notLive = 'Not signed in.',
): OperatorFunction<EngineResult<T>, T> {
  return (source) =>
    source.pipe(
      map((result) => {
        if (!result.ok && result.failure.code === 'account-not-live') {
          throw new Error(notLive);
        }
        return result;
      }),
      unwrapEngineResult<T>(),
    );
}

function createRequestOf(options: CreateRoomOptions): CreateRoomRequest {
  return {
    name: options.name,
    topic: options.topic ?? null,
    isPublic: options.isPublic ?? false,
    kind: 'room',
    parentSpaceId: null,
  };
}
