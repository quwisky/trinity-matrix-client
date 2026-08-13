import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  output,
} from '@angular/core';
import {
  HlmDropdownMenu,
  HlmDropdownMenuItem,
  HlmDropdownMenuItemSubIndicator,
  HlmDropdownMenuLabel,
  HlmDropdownMenuRadio,
  HlmDropdownMenuRadioIndicator,
  HlmDropdownMenuSeparator,
  HlmDropdownMenuSub,
  HlmDropdownMenuSubTrigger,
  HlmDropdownMenuTrigger,
} from '@trinity/helm/dropdown-menu';
import { HlmInput } from '@trinity/helm/input';
import {
  AvatarComponent,
  BELOW_MD_QUERY,
  mediaQuerySignal,
  type AccountBadge,
} from '@trinity/ui';
import {
  InvitesService,
  MixedInvitesService,
  type PendingInvite,
} from '@trinity/data-access/invites';
import {
  PresenceService,
  type UserProfile,
} from '@trinity/data-access/profile';
import {
  AccountScopeService,
  DEFAULT_ROOM_SORT,
  RoomsService,
  SpacesService,
  TRINITY_ROOM_SORTS,
  type RoomSortMode,
  type RoomSummary,
  type SpaceChildRoom,
} from '@trinity/data-access/rooms';
import {
  RoomNotificationsService,
  type RoomNotifyMode,
} from '@trinity/data-access/notifications';
import { matchesRoomFilter, normalizeRoomFilter } from './room-filter';
import { AccountPickerService } from '../account-picker/account-picker.service';
import {
  SidebarUserPanelComponent,
  type AccountSummary,
} from './sidebar-user-panel/sidebar-user-panel.component';
import { SidebarRoomListComponent } from './sidebar-room-list/sidebar-room-list.component';
import { TrnIconComponent } from '@trinity/helm/icon';

export type { AccountSummary };

/** Discord channel sidebar: space header, invites, room list, and the user panel. */
@Component({
  selector: 'trn-channel-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    SidebarUserPanelComponent,
    SidebarRoomListComponent,
    AvatarComponent,
    TrnIconComponent,
    HlmInput,
    HlmDropdownMenuTrigger,
    HlmDropdownMenu,
    HlmDropdownMenuItem,
    HlmDropdownMenuItemSubIndicator,
    HlmDropdownMenuLabel,
    HlmDropdownMenuRadio,
    HlmDropdownMenuRadioIndicator,
    HlmDropdownMenuSeparator,
    HlmDropdownMenuSub,
    HlmDropdownMenuSubTrigger,
  ],
  templateUrl: './channel-sidebar.component.html',
  styleUrl: './channel-sidebar.component.scss',
})
export class ChannelSidebarComponent {
  private readonly spacesSvc = inject(SpacesService);
  private readonly invitesSvc = inject(InvitesService);
  private readonly mixedInvites = inject(MixedInvitesService);
  private readonly accountScope = inject(AccountScopeService);
  private readonly roomsSvc = inject(RoomsService);
  private readonly presence = inject(PresenceService);
  private readonly roomNotifications = inject(RoomNotificationsService);
  private readonly accountPicker = inject(AccountPickerService);

  /**
   * True on the narrow single-pane layout, where this sidebar is a full-screen page and its
   * user panel is a bar across the bottom of the viewport. A signal rather than a one-shot
   * read so rotating a phone re-renders the affordance instead of stranding whichever one the
   * page happened to load with.
   */
  protected readonly narrowLayout = mediaQuerySignal(BELOW_MD_QUERY);

  readonly spaceName = input('Home');
  /** Whether a space (not Home) is selected — gates the header space actions. */
  readonly spaceActive = input(false);
  /**
   * Whether the active space belongs to the signed-in account. Writes always go through the
   * ACTIVE client, so in the mixed-account view another account's space would open a dialog
   * that is read-only and blank — hide the row instead of offering that.
   */
  readonly canConfigureSpace = input(false);
  /**
   * Whether the viewer may curate this space's child list (`m.space.child`). Separate
   * from {@link canConfigureSpace}: curating is its own power level, so a moderator can
   * hold it without being able to rename the space, and vice versa.
   */
  readonly canCurateSpace = input(false);
  /** Already narrowed by {@link filterQuery} — the shell filters, so that the Alt+↑/↓ room
   * walk steps through exactly what is on screen (`RoomShellStore.roomFilter`). */
  readonly rooms = input<RoomSummary[]>([]);

  /**
   * Whether any room has unread messages — gates the "Mark all as read" affordance.
   *
   * An input rather than a computed over {@link rooms}, because that list arrives filtered:
   * the button marks EVERY room read, so hiding it because the current filter excludes the
   * unread ones would misrepresent what it does.
   */
  readonly hasAnyUnread = input(false);

  /**
   * The sidebar's in-place filter, two-way bound to the shell. Separate from the Ctrl/Cmd+K
   * switcher, which closes on selection: this one narrows the list and stays out of the way
   * while you work through the result.
   *
   * The shell owns the value (and resets it on a view change) because the room walk has to
   * see the same narrowing; this component owns the box that edits it.
   */
  readonly filterQuery = model('');

  /** The folded query, computed once per keystroke rather than once per row below. */
  private readonly normalizedFilter = computed(() =>
    normalizeRoomFilter(this.filterQuery()),
  );

  /** Whether a filter is actually narrowing anything (an all-whitespace query is not). */
  protected readonly filterActive = computed(
    () => this.normalizedFilter() !== '',
  );

  /**
   * What the filter's live region announces. Counts everything the box narrows, not just
   * joined rooms, because that is what changed on screen.
   */
  protected readonly filterStatus = computed(() => {
    const count =
      this.rooms().length +
      this.filteredInvites().length +
      this.filteredJoinableRooms().length +
      this.filteredChildSpaces().length;
    return count === 1 ? '1 result' : `${count} results`;
  });

  protected clearFilter(): void {
    this.filterQuery.set('');
  }

  /**
   * Escape clears the box, and only then. Left to bubble when the box is already empty so
   * the shell's own Escape handling (closing the panel behind it) still works — swallowing
   * it unconditionally would strand a user whose focus happens to sit here.
   */
  protected onFilterEscape(event: Event): void {
    if (!this.filterQuery()) {
      return;
    }
    event.stopPropagation();
    this.clearFilter();
  }

  /** The account badge for a room row (mixed view), or null when not badged. */
  /**
   * Show the account picker as a dialog (narrow layout only — see {@link narrowLayout}).
   *
   * The dialog writes through AccountScopeService itself rather than routing back out via
   * `toggleAccountShown`, so these ticks do not pass through RoomsPage the way the submenu's
   * do. Both end in the same service call.
   */
  protected onOpenAccountPicker(): void {
    void this.accountPicker.open({
      accounts: this.accounts(),
      activeUserId: this.activeUserId(),
    });
  }

  /** Not-yet-joined channels of the active space (the "More Channels" list). */
  readonly joinableRooms = this.spacesSvc.notJoinedRooms;
  /** Sub-spaces of the active space (joined → Open, otherwise Join). */
  readonly childSpaces = this.spacesSvc.childSpaces;

  // The filter box sits above the whole scroll area, so it narrows everything under it —
  // not just the joined rooms. A box that visibly ignored the two lists below the fold
  // would read as broken.
  protected readonly filteredJoinableRooms = computed(() =>
    this.joinableRooms().filter((child) =>
      matchesRoomFilter(child.name, this.normalizedFilter()),
    ),
  );
  protected readonly filteredChildSpaces = computed(() =>
    this.childSpaces().filter((child) =>
      matchesRoomFilter(child.name, this.normalizedFilter()),
    ),
  );
  /** Whether the active space's child hierarchy is still loading. */
  readonly childrenLoading = this.spacesSvc.childrenLoading;
  /** Non-null when the active space's child hierarchy failed to load. */
  readonly childrenError = this.spacesSvc.childrenError;
  /** Pending invites surfaced in an "Invites" group above the channels — across every
   * mixed account, so an invite to one you aren't currently acting as is still visible. */
  readonly invites = computed<readonly PendingInvite[]>(() =>
    this.accountScope.mixing()
      ? this.mixedInvites.invites()
      : this.invitesSvc.pendingInvites(),
  );

  protected readonly filteredInvites = computed(() =>
    this.invites().filter((invite) =>
      matchesRoomFilter(invite.name, this.normalizedFilter()),
    ),
  );
  readonly activeRoomId = input<string | null>(null);
  /** The signed-in user (name + handle + avatar) for the bottom user panel. */
  readonly user = input<UserProfile>({
    userId: '',
    displayName: '',
    avatarMxc: null,
  });
  /** Every signed-in account, for the switcher list in the user panel. */
  readonly accounts = input<AccountSummary[]>([]);
  /** The user id of the account currently in view (marked with a check). */
  readonly activeUserId = input<string | null>(null);
  /** User ids of accounts the server signed out that need re-authentication. */
  readonly reauthAccounts = input<readonly string[]>([]);
  /**
   * Owning-account badge per account id (mixed-account view): account id → its avatar/
   * initial/name. Empty when not in mixed mode — room rows then show no badge.
   */
  readonly accountBadges = input<ReadonlyMap<string, AccountBadge>>(new Map());
  /**
   * The accounts the view currently draws from (the user's picker selection). Passed to the
   * user panel, which renders the picker and the stacked-avatar indicator.
   */
  readonly shownAccountIds = input<ReadonlySet<string>>(new Set());
  /** The user ticked/unticked an account in the picker. */
  readonly toggleAccountShown = output<string>();
  readonly selectRoom = output<string>();
  /** Header "+" on Home — raise the new-room / new-DM chooser. */
  readonly newChat = output<void>();
  /** Header "+" in a space — raise the create-a-channel flow. */
  readonly createRoom = output<void>();
  /** "Invite people", from the space overflow menu — raise the invite-to-space flow. */
  readonly inviteToSpace = output<void>();
  /** "Members", from the space overflow menu — list and moderate the space's members. */
  readonly openSpaceMembers = output<void>();
  /** "Add existing rooms", from the space overflow menu. */
  readonly addToSpace = output<void>();
  /** "Create a space inside", from the space overflow menu — nest a new space. */
  readonly createSubspace = output<void>();
  /** "Organise rooms", from the space overflow menu — open child curation. */
  readonly manageSpaceRooms = output<void>();
  /** "Space settings", from the space overflow menu — open the settings dialog. */
  readonly openSpaceSettings = output<void>();
  /** "Leave space", from the space overflow menu — raise the leave confirmation. */
  readonly leaveSpace = output<void>();
  /** Join a not-yet-joined child room or sub-space of the active space. */
  readonly joinRoom = output<SpaceChildRoom>();
  /** Remove (unlink) a joined channel from the active space, by room id. */
  readonly removeRoom = output<string>();
  /** Leave a joined room entirely (not just unlink from a space); carries the owning
   * account so a mixed-in row leaves on ITS account, never the active one. */
  readonly leaveRoom = output<{ roomId: string; accountId: string }>();
  /** Open a joined sub-space (select it in the rail), by room id. */
  readonly openChildSpace = output<string>();
  /** Accept / decline a pending invite by room id. */
  readonly acceptInvite = output<{ roomId: string; accountId: string }>();
  readonly declineInvite = output<{ roomId: string; accountId: string }>();
  /** Header search icon — open the global quick switcher (Ctrl/Cmd+K). */
  readonly openSwitcher = output<void>();
  /** User-panel gear — open the settings page. */
  readonly openSettings = output<void>();
  /** Switch the active account to the given user id (a switcher row that isn't active). */
  readonly switchAccount = output<string>();
  /** Re-authenticate a soft-logged-out account by its user id. */
  readonly reauthAccount = output<string>();
  /** User panel "Add account" — start a login in add mode. */
  readonly addAccount = output<void>();
  /** Sign out the given account (the active one, from the user panel). */
  readonly logout = output<string>();
  /** Set a room's notification level (all / mentions / mute) from its ⋮ menu. */
  readonly setNotifyMode = output<{
    roomId: string;
    mode: RoomNotifyMode;
    accountIds: readonly string[];
  }>();
  /** Mark a single room read (from its ⋮ menu); carries every owning account, since a row
   * merged from two mixed accounts only clears when both are acked. */
  readonly markRead = output<{
    roomId: string;
    accountIds: readonly string[];
  }>();
  /** Flag a read room to come back to. Carries every owning account for the same reason
   * {@link markRead} does: a merged row is only flagged where the write actually lands. */
  readonly markUnread = output<{
    roomId: string;
    accountIds: readonly string[];
  }>();
  /** Mark every room read. Inline on Home; a row in the overflow menu inside a space. */
  readonly markAllRead = output<void>();

  /** The ordering the open space's list is currently using (drives the radio checks). */
  readonly sortMode = input<RoomSortMode>(DEFAULT_ROOM_SORT);
  /** Whether that ordering is the space's own override rather than the account default. */
  readonly sortOverridden = input(false);
  /** The active account's default ordering, named in the "Use my default (…)" row. */
  readonly defaultSortMode = input<RoomSortMode>(DEFAULT_ROOM_SORT);
  /**
   * Order this space's rooms this way, from the "Order rooms" submenu of the space overflow.
   * `null` means "follow my account default", which drops the override. One output because
   * the rows are one radio group.
   */
  readonly setSortMode = output<RoomSortMode | null>();

  /** The orderings offered in the "Order rooms" submenu. */
  readonly sortModes = TRINITY_ROOM_SORTS;

  /** What the "Order rooms" row announces — the effective order, override or not. */
  readonly sortModeLabel = computed(() => this.labelFor(this.sortMode()));

  /** An ordering's human label. */
  labelFor(mode: RoomSortMode): string {
    return TRINITY_ROOM_SORTS.find((option) => option.id === mode)?.label ?? '';
  }

  /** Cap an unread count for a room-row badge, Discord-style ("99+"). */
}
