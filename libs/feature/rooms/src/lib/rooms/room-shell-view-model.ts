import { Injectable, computed, inject } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  AccountScopeService,
  MixedRoomsService,
  MixedSpacesService,
  RoomsService,
  SpaceChildrenService,
  SpaceRoomOrderService,
  SpacesService,
  UnreadAggregatorService,
  comparatorFor,
  type RoomSortMode,
  type RoomSummary,
  type SpaceSummary,
} from '@trinity/data-access/rooms';
import { AccountBadgesService } from '../shared/account-badges.service';
import { RoomShellStore } from './room-shell-store';
import { type UserProfile } from '@trinity/data-access/profile';
import { type RailUnread } from '../server-rail/server-rail.component';
import { type AccountSummary } from '../channel-sidebar/channel-sidebar.component';

/**
 * Everything the rooms shell derives, and nothing it does.
 *
 * Pure `computed()` over {@link RoomShellStore} and the data-access read models — no
 * writes, no subscriptions, no side effects. That is what lets the workflow coordinators
 * and this class both depend on the store without forming a cycle: derived state reads the
 * selection, workflows write it, and neither sees the other.
 *
 * Page-scoped alongside the store, so the memoised computeds are torn down with the page
 * rather than outliving it in the root injector.
 */
@Injectable()
export class RoomShellViewModel {
  private readonly store = inject(RoomShellStore);
  private readonly rooms = inject(RoomsService);
  private readonly spaces = inject(SpacesService);
  private readonly spaceChildren = inject(SpaceChildrenService);
  private readonly mixedRooms = inject(MixedRoomsService);
  private readonly mixedSpaces = inject(MixedSpacesService);
  private readonly accountScope = inject(AccountScopeService);
  private readonly spaceOrder = inject(SpaceRoomOrderService);
  private readonly accountBadgesSvc = inject(AccountBadgesService);
  private readonly unreadAgg = inject(UnreadAggregatorService);
  private readonly matrix = inject(MatrixClientService);

  /** Ids of every joined room that is a child of some space, unioned across all spaces.
   * Used to keep space-owned rooms out of the flat Rooms view (they live in their space).
   * In mixed mode this spans every account's spaces so the global Rooms list excludes
   * space-owned rooms from all accounts, matching the single-account view. */
  private readonly spaceChildRoomIds = computed<Map<string, Set<string>>>(
    () => {
      const byAccount = new Map<string, Set<string>>();
      const spaces = this.accountScope.mixing()
        ? this.mixedSpaces.spaces()
        : this.spaces.spaces();
      for (const space of spaces) {
        const ids = byAccount.get(space.accountId) ?? new Set<string>();
        for (const id of space.childRoomIds) ids.add(id);
        byAccount.set(space.accountId, ids);
      }
      return byAccount;
    },
  );

  /** Whether a row is filed under one of ITS OWN account's spaces. Keyed per account: a
   * room that is top-level for the account you're acting as must not vanish from the Rooms
   * view just because a different mixed account files it inside one of its spaces. */
  private isSpaceChild(room: RoomSummary): boolean {
    const byAccount = this.spaceChildRoomIds();
    return room.accountIds.some((id) => byAccount.get(id)?.has(room.id));
  }

  /**
   * Rooms shown in the channel sidebar. Home (`null`, the default) shows only direct
   * messages (`m.direct`) in recency order. The Rooms view shows every non-DM joined
   * room that does not belong to any space (space-owned rooms live under their space).
   * A selected space shows only its joined child rooms, in the ordering that space resolves
   * to — its own override, else the active account's default (recent activity out of the
   * box). All read live signals, so the list reacts to sync, membership, `m.space.child`
   * changes, and to the ordering being changed from the sidebar or Settings.
   *
   * When the global "All accounts" scope is on ({@link mixedOn}), every list — Recent,
   * Home's DMs and the Rooms view — reads the cross-account {@link MixedRoomsService}
   * instead of the active account's rooms, classifying DMs by each row's own-account
   * `m.direct` (`directUserId`) rather than the active account's `directRoomIds()`.
   */
  readonly visibleRooms = computed<RoomSummary[]>(() => {
    const mixed = this.accountScope.mixing();
    // Recent activity: every joined DM + room, mixed by recency. In mixed mode that spans
    // every signed-in account (each row badged); otherwise the active account's `rooms()`
    // — already exactly that list, favourite-first then most-recent, used unfiltered.
    if (this.store.recentView()) {
      return mixed ? this.mixedRooms.rooms() : this.rooms.rooms();
    }
    const all = mixed ? this.mixedRooms.rooms() : this.rooms.rooms();
    // Rooms view: non-DM joined rooms that aren't owned by a space (overrides the space scope).
    if (this.store.roomsView()) {
      return all.filter(
        (room) => !this.isDirectRow(room) && !this.isSpaceChild(room),
      );
    }
    const spaceId = this.store.activeSpaceId();
    if (!spaceId) {
      // Home: direct messages only.
      return all.filter((room) => this.isDirectRow(room));
    }
    // While mixing, take the children from the mixed projection — the same union the space
    // pill's unread badge is summed over. Reading the active account's SpacesService here
    // would list fewer rooms than the badge counted for a space BOTH accounts have joined,
    // leaving an unread total with nothing on screen to clear it. Foreign children are safe:
    // every row opens through onSelectRoomRow, which switches accounts first.
    const byId = new Map(all.map((room) => [room.id, room] as const));
    const childIds = this.accountScope.mixing()
      ? (this.mixedSpaces.spaces().find((s) => s.id === spaceId)
          ?.childRoomIds ?? [])
      : this.spaces.childRoomIds(spaceId);
    // `map().filter()` already allocates, so sorting in place here cannot reach the shared
    // `rooms()` array these rows came from — `sort` mutates, and the Recent branch above
    // hands that array out by identity.
    const children = childIds
      .map((id) => byId.get(id))
      .filter((room): room is RoomSummary => room !== undefined);
    return children.sort(
      comparatorFor(this.spaceOrder.effectiveFor(spaceId), childIds),
    );
  });

  /**
   * The ordering the open space's rooms are listed in — its own override, else the active
   * account's default. Drives the sidebar header menu's radio checks.
   */
  readonly spaceSortMode = computed<RoomSortMode>(() =>
    this.spaceOrder.effectiveFor(this.store.activeSpaceId()),
  );

  /**
   * Whether that ordering is the space's own override rather than the account default —
   * what separates a checked "Recent activity" from a checked "Use my default".
   */
  readonly spaceSortOverridden = computed(
    () => this.spaceOrder.overrideFor(this.store.activeSpaceId()) !== null,
  );

  /** The active account's default ordering, named in the menu's "Use my default (…)" row. */
  readonly defaultSpaceSortMode = this.spaceOrder.defaultMode;

  readonly activeSpaceName = computed(() => {
    const id = this.store.activeSpaceId();
    if (!id) {
      return 'Home';
    }
    return this.spaces.spaces().find((s) => s.id === id)?.name ?? 'Home';
  });

  /** Channel-sidebar header: Recent activity, the Rooms view, a selected space, else Home's DMs. */
  readonly sidebarTitle = computed(() => {
    if (this.store.recentView()) {
      return 'Recent activity';
    }
    if (this.store.roomsView()) {
      return 'Rooms';
    }
    return this.store.activeSpaceId()
      ? this.activeSpaceName()
      : 'Direct Messages';
  });

  /**
   * Whether a room row counts as a direct message in the current scope: in mixed mode by
   * the row's own-account `m.direct` (`directUserId`), otherwise by the active account's
   * `directRoomIds()` set. Shared by {@link visibleRooms} and the rail unread badges so the
   * badges count exactly what their view shows.
   */
  private isDirectRow(room: RoomSummary): boolean {
    return this.accountScope.mixing()
      ? room.directUserId != null
      : this.rooms.directRoomIds().has(room.id);
  }

  /** The room list the rail badges count over — every account's in mixed mode, else the
   * active account's — so each badge matches what its view renders. */
  private railRoomSource(): RoomSummary[] {
    return this.accountScope.mixing()
      ? this.mixedRooms.rooms()
      : this.rooms.rooms();
  }

  /** Total unread notifications across everything the Recent view lists (its rail badge). */
  readonly recentUnread = computed(() =>
    this.railRoomSource().reduce((sum, r) => sum + r.unreadCount, 0),
  );

  /** Total unread notifications across direct-message rooms (Home rail badge). */
  readonly homeUnread = computed(() =>
    this.railRoomSource().reduce(
      (sum, r) => (this.isDirectRow(r) ? sum + r.unreadCount : sum),
      0,
    ),
  );

  /** Total unread notifications across the Rooms view — non-DM rooms that don't
   * belong to any space (space unread is surfaced on the space pills). */
  readonly roomsUnread = computed(() => {
    return this.railRoomSource().reduce(
      (sum, r) =>
        this.isDirectRow(r) || this.isSpaceChild(r) ? sum : sum + r.unreadCount,
      0,
    );
  });

  /** Unread notifications summed per space, keyed by space id (space-pill badges). In mixed
   * mode this covers every account's space pills, summing over that account's child rooms. */
  readonly spaceUnread = computed<Record<string, number>>(() => {
    const mixed = this.accountScope.mixing();
    const source = mixed ? this.mixedRooms.rooms() : this.rooms.rooms();
    const byId = new Map(source.map((r) => [r.id, r] as const));
    const spaces = mixed ? this.mixedSpaces.spaces() : this.spaces.spaces();
    const totals: Record<string, number> = {};
    for (const space of spaces) {
      const childIds = mixed
        ? space.childRoomIds
        : this.spaces.childRoomIds(space.id);
      totals[space.id] = childIds.reduce((sum, id) => {
        const room = byId.get(id);
        // A flagged room has no notification count behind it, so it counts as one —
        // otherwise the pill for the space holding it stays blank and the flag is
        // invisible from everywhere except that space's own list.
        return sum + (room?.unreadCount || (room?.markedUnread ? 1 : 0));
      }, 0);
    }
    return totals;
  });

  /** The rail's unread badges bundled into one object input. */
  readonly railUnread = computed<RailUnread>(() => ({
    recent: this.recentUnread(),
    home: this.homeUnread(),
    rooms: this.roomsUnread(),
    perSpace: this.spaceUnread(),
  }));

  readonly activeRoom = computed(() => {
    const id = this.store.activeRoomId();
    return id ? (this.rooms.rooms().find((r) => r.id === id) ?? null) : null;
  });

  readonly members = computed(() => {
    // Recompute only when membership actually changes — not on every sync tick or
    // read receipt (those bump `revision`, which the member list doesn't depend on).
    this.rooms.memberRevision();
    return this.rooms.membersOf(this.store.activeRoomId());
  });

  /**
   * Whether the open room is a direct message. Drives the member surfaces, which must not
   * name an owner in a 1:1 chat — both participants are at power level 100 there.
   */
  readonly activeRoomIsDirect = computed(() => {
    const roomId = this.store.activeRoomId();
    return !!roomId && this.rooms.directRoomIds().has(roomId);
  });

  /** The active account's user id — recomputes when the account is switched. */
  readonly userId = computed(() => this.matrix.activeUserId() ?? '');

  readonly userName = computed(() => {
    this.rooms.revision(); // re-read once the user's profile hydrates on sync
    const uid = this.userId();
    if (!uid || !this.matrix.isInitialized) {
      return uid;
    }
    return this.matrix.instance.getUser(uid)?.displayName ?? uid;
  });

  readonly userAvatarMxc = computed(() => {
    this.rooms.revision(); // re-read once the user's profile hydrates on sync
    const uid = this.userId();
    if (!uid || !this.matrix.isInitialized) {
      return null;
    }
    return this.matrix.instance.getUser(uid)?.avatarUrl ?? null;
  });

  /** First letter of the active account's display name, for the header chip's avatar. */
  readonly userInitial = computed(() =>
    (
      this.userName()
        .replace(/^[@#!]+/, '')
        .trim()[0] ?? '?'
    ).toUpperCase(),
  );

  /** The signed-in user's profile, bundled for the channel sidebar's user panel. */
  readonly userProfile = computed<UserProfile>(() => ({
    userId: this.userId(),
    displayName: this.userName(),
    avatarMxc: this.userAvatarMxc(),
  }));

  /** Every signed-in account, for the user-panel switcher (profile + unread total). */
  readonly accounts = computed<AccountSummary[]>(() => {
    this.rooms.revision(); // re-read each account's profile as it hydrates on sync
    const unread = this.unreadAgg.unreadByAccount();
    return this.matrix.accountIds().map((userId) => {
      const user = this.matrix.clientFor(userId)?.getUser(userId);
      return {
        userId,
        displayName: user?.displayName || userId,
        avatarMxc: user?.avatarUrl ?? null,
        unread: unread.get(userId) ?? 0,
      };
    });
  });

  /** The account currently in view — marks the active row in the switcher. */
  readonly activeAccountId = this.matrix.activeUserId;

  /**
   * Space pills for the rail: every signed-in account's spaces (badged) in mixed mode,
   * else just the active account's.
   */
  readonly railSpaces = computed<SpaceSummary[]>(() =>
    this.accountScope.mixing()
      ? this.mixedSpaces.spaces()
      : this.spaces.spaces(),
  );

  /**
   * Whether the active space's child list may be curated. A separate power level from
   * renaming the space, so this is not {@link canConfigureSpace} — a moderator can hold
   * one without the other — but it carries the same mixed-account guard, since the write
   * still goes through the ACTIVE client.
   */
  readonly canCurateSpace = computed(() => {
    const spaceId = this.store.activeSpaceId();
    return (
      !!spaceId &&
      this.ownsActiveSpace() &&
      this.spaceChildren.canCurate(spaceId)
    );
  });

  /** Whether the active space belongs to the signed-in account. */
  private readonly ownsActiveSpace = computed(() => {
    const spaceId = this.store.activeSpaceId();
    if (!spaceId) {
      return false;
    }
    const space = this.railSpaces().find((s) => s.id === spaceId);
    return !!space && space.accountId === this.matrix.activeUserId();
  });

  /**
   * Whether "Space settings" is offered for the active space. False for another account's
   * space in mixed mode: `RoomSettingsService` resolves the ACTIVE client, so the dialog
   * would seed blank and every write would land on the wrong account — or nowhere.
   */
  readonly canConfigureSpace = computed(
    () => !!this.store.activeSpaceId() && this.ownsActiveSpace(),
  );

  /**
   * Account-badge lookup for the sidebar rows + rail pills, shared with the quick switcher
   * so every mixed surface badges rows the same way. Empty when not mixing.
   */
  readonly accountBadges = this.accountBadgesSvc.badges;

  /** Accounts the server signed out that need re-authentication (switcher re-auth rows). */
  readonly reauthAccounts = this.matrix.softLoggedOut;

  readonly syncLabel = computed(() => {
    const state = String(this.matrix.syncState() ?? '');
    if (state === 'PREPARED' || state === 'SYNCING') {
      return 'Welcome to Trinity';
    }
    if (state === 'ERROR' || state === 'RECONNECTING') {
      return 'Reconnecting…';
    }
    return 'Connecting…';
  });
}
