import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
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
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowDownWideNarrow,
  lucideBell,
  lucideCheck,
  lucideCheckCheck,
  lucideCircleMinus,
  lucideCommand,
  lucideEllipsisVertical,
  lucideLogOut,
  lucidePlus,
  lucideStar,
  lucideUserPlus,
  lucideX,
} from '@ng-icons/lucide';
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
} from '@trinity/data-access-invites';
import {
  PresenceService,
  type UserProfile,
} from '@trinity/data-access-profile';
import {
  AccountScopeService,
  DEFAULT_ROOM_SORT,
  RoomsService,
  SpacesService,
  TRINITY_ROOM_SORTS,
  type RoomSortMode,
  type RoomSummary,
  type SpaceChildRoom,
} from '@trinity/data-access-rooms';
import {
  RoomNotificationsService,
  type RoomNotifyMode,
} from '@trinity/data-access-notifications';
import { type PresenceState } from '@trinity/util-matrix';
import { unreadBadgeLabel } from '../shared/unread-badge';
import { AccountPickerService } from '../account-picker/account-picker.service';
import {
  SidebarUserPanelComponent,
  type AccountSummary,
} from './sidebar-user-panel/sidebar-user-panel.component';

export type { AccountSummary };

/** Discord channel sidebar: space header, invites, room list, and the user panel. */
@Component({
  selector: 'trn-channel-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    SidebarUserPanelComponent,
    AvatarComponent,
    NgIcon,
    NgTemplateOutlet,
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
  viewProviders: [
    provideIcons({
      lucideArrowDownWideNarrow,
      lucideBell,
      lucideCheck,
      lucideCheckCheck,
      lucideCircleMinus,
      lucideCommand,
      lucideEllipsisVertical,
      lucideLogOut,
      lucidePlus,
      lucideStar,
      lucideUserPlus,
      lucideX,
    }),
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
  readonly rooms = input<RoomSummary[]>([]);
  /**
   * Favourite rooms (`m.favourite`), rendered under a "Favourite" header. The service
   * already sorts favourite-first, so a stable partition keeps activity order within
   * each group.
   */
  readonly favouriteRooms = computed(() =>
    this.rooms().filter((r) => r.favourite),
  );
  /** The rest of the rooms, rendered below the favourite group. */
  readonly otherRooms = computed(() =>
    this.rooms().filter((r) => !r.favourite),
  );
  /** Whether any room has unread messages — gates the "Mark all as read" affordance. */
  readonly hasAnyUnread = computed(() => this.rooms().some((r) => r.hasUnread));

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

  badgeFor(accountId: string): AccountBadge | null {
    return this.accountBadges().get(accountId) ?? null;
  }
  /** Not-yet-joined channels of the active space (the "More Channels" list). */
  readonly joinableRooms = this.spacesSvc.notJoinedRooms;
  /** Sub-spaces of the active space (joined → Open, otherwise Join). */
  readonly childSpaces = this.spacesSvc.childSpaces;
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
  readonly badgeLabel = unreadBadgeLabel;

  /**
   * Live online status for a direct message's other participant, or null for a non-DM
   * room (which gets no presence dot). Reads the memoized per-user presence signal, so
   * the row updates when that user's presence changes.
   */
  presenceOf(room: RoomSummary): PresenceState | null {
    // Presence is projected from the ACTIVE client only, so a mixed-in account's DM partner
    // has no entry there and would render a grey dot — indistinguishable from genuinely
    // offline. Show nothing rather than something false.
    const active = this.activeUserId();
    if (
      !room.directUserId ||
      (active && room.accountId && room.accountId !== active)
    ) {
      return null;
    }
    return this.presence.presenceFor(room.directUserId)();
  }

  /** Fire-and-forget: flip the room's `m.favourite` tag via the rooms service, on the
   * account that owns the row (not necessarily the active one). */
  toggleFavourite(room: RoomSummary): void {
    // Across every account joined to the row, so a merged row's star doesn't flip back.
    for (const accountId of room.accountIds) {
      this.roomsSvc.setFavourite(room.id, !room.favourite, accountId);
    }
  }

  /**
   * The room's current notification level, read fresh from its push rules to seed the
   * ⋮ menu's radio checks. Re-read each time the submenu opens (the write is delegated to
   * the host via {@link setNotifyMode}), so the check reflects the persisted preference.
   */
  notifyMode(room: RoomSummary): RoomNotifyMode {
    return this.roomNotifications.modeFor(room.id, room.accountId);
  }
}
