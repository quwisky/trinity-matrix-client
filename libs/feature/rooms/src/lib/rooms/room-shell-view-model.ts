import { Injectable, computed, inject } from '@angular/core';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import {
  RoomActionPermissionsService,
  RoomMembersService,
} from '@trinity/data-access/room-administration';
import {
  RoomLibraryService,
  SelectedRoomLibraryService,
  RailUnreadChatsPreference,
  SpaceRoomOrderService,
  UnreadAggregatorService,
  DEFAULT_ROOM_SORT,
  comparatorFor,
  filterRoomLibraryItems,
  type RoomSortMode,
  type RoomSummary,
  type SpaceSummary,
} from '@trinity/data-access/room-library';
import { initialOf } from '@trinity/util/matrix';
import { type WorkspaceNavigationScope } from '@trinity/application/workspace';
import { type ExactRoomSelection } from '../shared/exact-selection';
import { AccountBadgesService } from '../shared/account-badges.service';
import { RoomShellStore } from './room-shell-store';
import {
  AccountIdentitiesService,
  type IdentityProfile,
} from '@trinity/data-access/identity';
import {
  buildRailUnreadChats,
  type RailUnreadChats,
} from '../server-rail/rail-unread-chats';
import { TrustAccountStatusService } from '@trinity/data-access/trust';
import { type RailUnread } from '../server-rail/server-rail.component';
import { type AccountSummary } from '../channel-sidebar/sidebar-user-panel/sidebar-user-panel.component';

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
  private readonly rooms = inject(RoomLibraryService);
  private readonly selectedLibrary = inject(SelectedRoomLibraryService);
  private readonly membersProjection = inject(RoomMembersService);
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly spaceOrder = inject(SpaceRoomOrderService);
  private readonly accountBadgesSvc = inject(AccountBadgesService);
  private readonly unreadAgg = inject(UnreadAggregatorService);
  private readonly railUnreadPreference = inject(RailUnreadChatsPreference);
  private readonly matrix = inject(SessionStateService);
  private readonly identities = inject(AccountIdentitiesService);
  private readonly accountTrust = inject(TrustAccountStatusService);

  /** Whether a row is filed under one of its selected owner's spaces. A shared Room uses
   * the hierarchy of the Account that won the selected-view row, just as its actions do. */
  private isSpaceChild(room: RoomSummary): boolean {
    return (
      this.selectedLibrary
        .view()
        .spaceChildRoomIdsByAccount.get(room.accountId)
        ?.has(room.id) ?? false
    );
  }

  /**
   * Rooms shown in the channel sidebar. Home (`null`, the default) shows only direct
   * messages (`m.direct`) in recency order. The Rooms view shows every non-DM joined
   * room that does not belong to any space (space-owned rooms live under their space).
   * A selected space shows only its joined child rooms, in the ordering that space resolves
   * to — its own override, else the account's default — for the account
   * {@link spaceOrderAccountId} names.
   *
   * Every list reads one selected Room Library generation. Room ownership, deduplication,
   * and active-versus-mixed source choice are already resolved by that boundary.
   */
  readonly visibleRooms = computed<readonly RoomSummary[]>(() => {
    const view = this.selectedLibrary.view();
    // Recent activity is already ordered by the selected projection and is used unfiltered.
    if (this.store.recentView()) {
      return view.rooms;
    }
    const all = view.rooms;
    // Rooms view: non-DM joined rooms that aren't owned by a space (overrides the space scope).
    if (this.store.roomsView()) {
      return all.filter((room) => this.isRoomsViewRow(room));
    }
    const spaceId = this.store.activeSpaceId();
    if (!spaceId) {
      // Home: direct messages only.
      return all.filter((room) => this.isDirectRow(room));
    }
    // The selected projection carries the same child union the space pill's unread badge
    // counts. Foreign children are safe: every row carries the Account that owns its action.
    const byId = new Map(all.map((room) => [room.id, room] as const));
    const childIds =
      view.spaces.find((space) => space.id === spaceId)?.childRoomIds ?? [];
    // `map().filter()` already allocates, so sorting in place here cannot reach the shared
    // `rooms()` array these rows came from — `sort` mutates, and the Recent branch above
    // hands that array out by identity.
    const children = childIds
      .map((id) => byId.get(id))
      .filter((room): room is RoomSummary => room !== undefined);
    return children.sort(comparatorFor(this.spaceSortMode(), childIds));
  });

  /**
   * The sidebar lists that show one Room, by the rules {@link visibleRooms} applies, filter
   * box aside. Recent lists every chat, and each space lists its children whatever their
   * kind. A Room the selected library does not hold is claimed only by Recent, the one list
   * that always has it.
   */
  listsShowing(
    selection: ExactRoomSelection,
  ): readonly WorkspaceNavigationScope[] {
    const view = this.selectedLibrary.view();
    const row = view.rooms.find(
      (room) =>
        room.id === selection.roomId &&
        room.accountIds.includes(selection.accountId),
    );
    if (!row) return [{ kind: 'recent' }];
    const spaces = view.spaces
      .filter((space) => space.childRoomIds.includes(row.id))
      .map((space) => ({ kind: 'space', spaceId: space.id }) as const);
    if (this.isDirectRow(row)) {
      return [{ kind: 'recent' }, { kind: 'home' }, ...spaces];
    }
    return this.isSpaceChild(row)
      ? [{ kind: 'recent' }, ...spaces]
      : [{ kind: 'recent' }, { kind: 'rooms' }, ...spaces];
  }

  /**
   * {@link visibleRooms} narrowed by the sidebar's filter box.
   *
   * This is what the sidebar renders AND what the Alt+↑/↓ room walk steps through, so the
   * keyboard can never land on a room the filter has hidden. Everything that acts on rooms
   * rather than displaying them — "mark all as read", name lookup — stays on the
   * unfiltered {@link visibleRooms}.
   */
  readonly filteredRooms = computed<readonly RoomSummary[]>(() => {
    return filterRoomLibraryItems(this.visibleRooms(), this.store.roomFilter());
  });

  /**
   * Whether any room has unread messages, read from the UNFILTERED list — "mark all as
   * read" marks every room, so hiding it because the current filter excludes the unread
   * ones would misrepresent what it does.
   */
  readonly anyRoomUnread = computed(() =>
    this.visibleRooms().some((room) => room.hasUnread),
  );

  /**
   * The account whose ordering the open space's list uses, and whose record the sort menu
   * writes: the space's owner in the selected view. That is the active account whenever it
   * holds the space. In the mixed view a space only another account holds keeps that
   * account's ordering, so opening one of its rooms as a different account does not
   * reorder the list.
   */
  readonly spaceOrderAccountId = computed(() => {
    const spaceId = this.store.activeSpaceId();
    const owner = spaceId
      ? this.railSpaces().find((space) => space.id === spaceId)?.accountId
      : undefined;
    return owner ?? this.matrix.activeAccountId();
  });

  private readonly spaceOrderSnapshot = computed(() => {
    const accountId = this.spaceOrderAccountId();
    return accountId
      ? this.spaceOrder.snapshotFor(accountId, this.store.activeSpaceId())
      : null;
  });

  /**
   * The ordering the open space's rooms are listed in — its own override, else the
   * account's default (see {@link spaceOrderAccountId}). Drives the sidebar header menu's
   * radio checks.
   */
  readonly spaceSortMode = computed<RoomSortMode>(
    () => this.spaceOrderSnapshot()?.effectiveMode ?? DEFAULT_ROOM_SORT,
  );

  /**
   * Whether that ordering is the space's own override rather than the account default —
   * what separates a checked "Recent activity" from a checked "Use my default".
   */
  readonly spaceSortOverridden = computed(
    () => (this.spaceOrderSnapshot()?.overrideMode ?? null) !== null,
  );

  /** That account's default ordering, named in the menu's "Use … default" row. */
  readonly defaultSpaceSortMode = computed<RoomSortMode>(
    () => this.spaceOrderSnapshot()?.defaultMode ?? DEFAULT_ROOM_SORT,
  );

  /**
   * The name of the account whose ordering the space follows, when it is not the account
   * on screen, so the menu says whose default it offers; `null` when it is "my" default.
   */
  readonly spaceOrderOwnerName = computed(() => {
    const accountId = this.spaceOrderAccountId();
    if (!accountId || accountId === this.matrix.activeAccountId()) return null;
    return this.accountBadges().get(accountId)?.name ?? accountId;
  });

  readonly activeSpaceName = computed(() => {
    const id = this.store.activeSpaceId();
    if (!id) {
      return 'Direct messages';
    }
    return (
      this.selectedLibrary.view().spaces.find((space) => space.id === id)
        ?.name ?? 'Direct messages'
    );
  });

  /**
   * Whether the selected space is listed: its pill is in the rail and its children are in
   * the sidebar. Its space actions and child list are offered only then.
   */
  readonly activeSpaceListed = computed(() => {
    const spaceId = this.store.activeSpaceId();
    return !!spaceId && this.railSpaces().some((space) => space.id === spaceId);
  });

  /**
   * A space is selected that the selected view does not list yet: restored before the
   * account's sync brings it, or about to be repaired to Recent once it turns out gone.
   */
  readonly activeSpacePending = computed(
    () => !!this.store.activeSpaceId() && !this.activeSpaceListed(),
  );

  readonly sidebarTitle = computed(() => {
    if (this.store.recentView()) {
      return 'Recent activity';
    }
    if (this.store.roomsView()) {
      return 'Rooms';
    }
    if (!this.store.activeSpaceId()) {
      return 'Direct messages';
    }
    return this.activeSpacePending()
      ? 'Loading space…'
      : this.activeSpaceName();
  });

  private isRoomsViewRow(room: RoomSummary): boolean {
    return !this.isDirectRow(room) && !this.isSpaceChild(room);
  }

  /**
   * Whether a selected row is a direct message. The selected projection preserves the
   * exact owning Account's `m.direct` classification on every row.
   */
  private isDirectRow(room: RoomSummary): boolean {
    return room.directUserId != null;
  }

  /** The room list the rail badges count over — every account's in mixed mode, else the
   * active account's — so each badge matches what its view renders. */
  private railRoomSource(): readonly RoomSummary[] {
    return this.selectedLibrary.view().rooms;
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
    const view = this.selectedLibrary.view();
    const source = view.rooms;
    const byId = new Map(source.map((r) => [r.id, r] as const));
    const totals: Record<string, number> = {};
    for (const space of view.spaces) {
      totals[space.id] = space.childRoomIds.reduce((sum, id) => {
        const room = byId.get(id);
        // A flagged room has no notification count behind it, so it counts as one —
        // otherwise the pill for the space holding it stays blank and the flag is
        // invisible from everywhere except that space's own list.
        return sum + (room?.unreadCount || (room?.markedUnread ? 1 : 0));
      }, 0);
    }
    return totals;
  });

  /** Mentions (highlight counts) over the same rooms each unread total covers. */
  private sumHighlights(include: (room: RoomSummary) => boolean): number {
    return this.railRoomSource().reduce(
      (sum, r) => (include(r) ? sum + r.highlightCount : sum),
      0,
    );
  }

  /** Mentions summed per space, over the same child rooms as {@link spaceUnread}. */
  readonly spaceMentions = computed<Record<string, number>>(() => {
    const view = this.selectedLibrary.view();
    const byId = new Map(view.rooms.map((r) => [r.id, r] as const));
    const totals: Record<string, number> = {};
    for (const space of view.spaces) {
      totals[space.id] = space.childRoomIds.reduce(
        (sum, id) => sum + (byId.get(id)?.highlightCount ?? 0),
        0,
      );
    }
    return totals;
  });

  /** The rail's unread and mention counts bundled into one object input. */
  readonly railUnread = computed<RailUnread>(() => {
    const mentions = this.spaceMentions();
    const perSpace: RailUnread['perSpace'] = {};
    for (const [id, unread] of Object.entries(this.spaceUnread())) {
      perSpace[id] = { unread, mentions: mentions[id] ?? 0 };
    }
    return {
      recent: {
        unread: this.recentUnread(),
        mentions: this.sumHighlights(() => true),
      },
      home: {
        unread: this.homeUnread(),
        mentions: this.sumHighlights((r) => this.isDirectRow(r)),
      },
      rooms: {
        unread: this.roomsUnread(),
        mentions: this.sumHighlights(
          (r) => !this.isDirectRow(r) && !this.isSpaceChild(r),
        ),
      },
      perSpace,
    };
  });

  /**
   * Unread chats for the rail, across every signed-in account. A chat counts as open only
   * while it is on screen: on a phone's list page the remembered chat is hidden, so it may
   * be listed again.
   */
  readonly railUnreadChats = computed<RailUnreadChats>(() => {
    const accountId = this.store.activeAccountId();
    const roomId = this.store.activeRoomId();
    const onScreen =
      !!accountId && !!roomId && this.store.placement() !== 'list';
    return buildRailUnreadChats({
      rooms: this.unreadAgg.unreadRooms(),
      mode: this.railUnreadPreference.mode(),
      open: onScreen ? { accountId, roomId } : null,
      activeAccountId: accountId,
      mixed: this.accountBadgesSvc.mixed(),
      badges: this.accountBadgesSvc.everyAccount(),
    });
  });

  readonly activeRoom = computed(() => {
    const id = this.store.activeRoomId();
    return id ? (this.rooms.rooms().find((r) => r.id === id) ?? null) : null;
  });

  readonly roomInvitePermission = computed(() => {
    const roomId = this.store.activeRoomId();
    return roomId
      ? this.permissions.room(roomId).invite
      : { available: false, reason: 'Open a room before inviting people.' };
  });

  readonly membersView = computed(() => {
    // Scoped to the open room: the signal is written only when a member event names it,
    // so a busy unrelated room cannot wake this list.
    return this.membersProjection.membersView(this.store.activeRoomId());
  });

  readonly members = computed(() => {
    const view = this.membersView();
    return view.current ?? view.stale ?? [];
  });

  /**
   * Whether the open room is a direct message. Drives the member surfaces, which must not
   * name an owner in a 1:1 chat — both participants are at power level 100 there.
   */
  readonly activeRoomIsDirect = computed(() => {
    const roomId = this.store.activeRoomId();
    return !!roomId && this.rooms.directRoomIds().has(roomId);
  });

  readonly userId = computed(() => this.matrix.activeAccountId() ?? '');

  // Both read the projection rather than the client: it is a declared dependency, so these
  // update when the profile hydrates instead of when something else happened to sync.
  readonly userName = computed(
    () => this.identities.identityOf(this.userId()).displayName,
  );

  readonly userAvatarMxc = computed(
    () => this.identities.identityOf(this.userId()).avatarMxc,
  );

  readonly userInitial = computed(() => initialOf(this.userName()));

  readonly userProfile = computed<IdentityProfile>(() => ({
    userId: this.userId(),
    displayName: this.userName(),
    avatarMxc: this.userAvatarMxc(),
  }));

  /** Every signed-in account, for the user-panel switcher (profile, unread total, trust). */
  readonly accounts = computed<AccountSummary[]>(() => {
    const unread = this.unreadAgg.unreadByAccount();
    const profiles = this.identities.identities();
    const trust = this.accountTrust.summaries();
    return this.matrix.accountIds().map((userId) => {
      const profile = profiles.get(userId);
      return {
        userId,
        displayName: profile?.displayName || userId,
        avatarMxc: profile?.avatarMxc ?? null,
        unread: unread.get(userId) ?? 0,
        trust: trust.get(userId) ?? 'unknown',
      };
    });
  });

  readonly activeAccountId = this.matrix.activeAccountId;

  /**
   * Space pills for the rail from the same selected generation as the Room lists.
   */
  readonly railSpaces = computed<readonly SpaceSummary[]>(
    () => this.selectedLibrary.view().spaces,
  );

  /**
   * Whether the active space's child list may be curated. A separate power level from
   * renaming the space, so this is not {@link canConfigureSpace} — a moderator can hold
   * one without the other — but it carries the same mixed-account guard, since the write
   * still goes through the ACTIVE client.
   */
  readonly spaceCuratePermission = computed(() => {
    const spaceId = this.store.activeSpaceId();
    if (!spaceId || !this.ownsActiveSpace()) {
      return {
        available: false,
        reason: 'Switch to the account that owns this space.',
      };
    }
    return this.permissions.room(spaceId).curateSpace;
  });

  readonly canCurateSpace = computed(
    () => this.spaceCuratePermission().available,
  );

  readonly spaceInvitePermission = computed(() => {
    const spaceId = this.store.activeSpaceId();
    if (!spaceId || !this.ownsActiveSpace()) {
      return {
        available: false,
        reason: 'Switch to the account that owns this space.',
      };
    }
    return this.permissions.room(spaceId).invite;
  });

  /**
   * Whether "Leave space" and "Members" are offered for the active space. Both act as the
   * ACTIVE account, so it has to hold the space: in the mixed view it can be showing a
   * space only another account holds, after opening one of that space's rooms.
   */
  readonly spaceMembershipPermission = computed(() =>
    this.ownsActiveSpace()
      ? { available: true, reason: null }
      : {
          available: false,
          reason: 'Switch to the account that owns this space.',
        },
  );

  private readonly ownsActiveSpace = computed(() => {
    const spaceId = this.store.activeSpaceId();
    if (!spaceId) {
      return false;
    }
    const space = this.railSpaces().find((s) => s.id === spaceId);
    return !!space && space.accountId === this.matrix.activeAccountId();
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
    const state = this.matrix.syncState();
    if (state === 'prepared' || state === 'syncing') {
      return 'Welcome to Trinity';
    }
    if (state === 'error' || state === 'reconnecting') {
      return 'Reconnecting…';
    }
    return 'Connecting…';
  });
}
