import { DestroyRef, Injectable, computed, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HomeserverInfoService } from '@trinity/data-access/homeserver';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  RoomActionPermissionsService,
  RoomMembersService,
} from '@trinity/data-access/room-administration';
import {
  RoomLibraryService,
  SelectedRoomLibraryService,
  SpaceRoomOrderService,
  UnreadAggregatorService,
  comparatorFor,
  filterRoomLibraryItems,
  type RoomSortMode,
  type RoomSummary,
  type SpaceSummary,
} from '@trinity/data-access/room-library';
import { AccountBadgesService } from '../shared/account-badges.service';
import { RoomShellStore } from './room-shell-store';
import {
  AccountIdentitiesService,
  type IdentityProfile,
} from '@trinity/data-access/identity';
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
  private readonly matrix = inject(MatrixClientService);
  private readonly identities = inject(AccountIdentitiesService);
  private readonly homeservers = inject(HomeserverInfoService);
  private readonly destroyRef = inject(DestroyRef);

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
   * to — its own override, else the active account's default (recent activity out of the
   * box). All read live signals, so the list reacts to sync, membership, `m.space.child`
   * changes, and to the ordering being changed from the sidebar or Settings.
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
      return all.filter(
        (room) => !this.isDirectRow(room) && !this.isSpaceChild(room),
      );
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
    return children.sort(
      comparatorFor(this.spaceOrder.effectiveFor(spaceId), childIds),
    );
  });

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
    return (
      this.selectedLibrary.view().spaces.find((space) => space.id === id)
        ?.name ?? 'Home'
    );
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

  readonly roomInvitePermission = computed(() => {
    const roomId = this.store.activeRoomId();
    return roomId
      ? this.permissions.room(roomId).invite
      : { available: false, reason: 'Open a room before inviting people.' };
  });

  readonly members = computed(() => {
    // Scoped to the open room: the signal is written only when a member event names it,
    // so a busy unrelated room cannot wake this list.
    return this.membersProjection.membersFor(this.store.activeRoomId())();
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

  // Both read the projection rather than the client: it is a declared dependency, so these
  // update when the profile hydrates instead of when something else happened to sync.
  readonly userName = computed(
    () => this.identities.identityOf(this.userId()).displayName,
  );

  readonly userAvatarMxc = computed(
    () => this.identities.identityOf(this.userId()).avatarMxc,
  );

  /** First letter of the active account's display name, for the header chip's avatar. */
  readonly userInitial = computed(() =>
    (
      this.userName()
        .replace(/^[@#!]+/, '')
        .trim()[0] ?? '?'
    ).toUpperCase(),
  );

  /** The signed-in user's profile, bundled for the channel sidebar's user panel. */
  readonly userProfile = computed<IdentityProfile>(() => ({
    userId: this.userId(),
    displayName: this.userName(),
    avatarMxc: this.userAvatarMxc(),
  }));

  /** Every signed-in account, for the user-panel switcher (profile + unread total). */
  readonly accounts = computed<AccountSummary[]>(() => {
    const unread = this.unreadAgg.unreadByAccount();
    const profiles = this.identities.identities();
    const servers = this.homeservers.infos();
    return this.matrix.accountIds().map((userId) => {
      const profile = profiles.get(userId);
      const software = servers.get(userId)?.software;
      return {
        userId,
        displayName: profile?.displayName || userId,
        avatarMxc: profile?.avatarMxc ?? null,
        unread: unread.get(userId) ?? 0,
        // Null until the menu has been opened once, and null again for a server that does
        // not publish a version — the switcher simply omits the line in both cases rather
        // than reserving space for a word like "Unknown" nobody came to the menu to read.
        server: software ? `${software.name} ${software.version}` : null,
      };
    });
  });

  /**
   * Look up each account's homeserver version, once per session.
   *
   * Driven by the account menu being opened rather than by startup: it is a request nobody
   * may ever want, and the answer is only visible in that menu and in Settings -> Server,
   * which loads it for itself. Cached, so reopening the menu costs nothing; the deliberate
   * re-check lives in the settings section.
   */
  loadHomeserverInfo(): void {
    this.homeservers
      .loadAll()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** The account currently in view — marks the active row in the switcher. */
  readonly activeAccountId = this.matrix.activeUserId;

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
