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
  HlmDropdownMenuRadio,
  HlmDropdownMenuRadioIndicator,
  HlmDropdownMenuSeparator,
  HlmDropdownMenuSub,
  HlmDropdownMenuSubTrigger,
  HlmDropdownMenuTrigger,
} from '@trinity/helm/dropdown-menu';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
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
import { AvatarComponent } from '@trinity/ui';
import { InvitesService } from '@trinity/data-access-invites';
import {
  PresenceService,
  type UserProfile,
} from '@trinity/data-access-profile';
import {
  RoomsService,
  SpacesService,
  type RoomSummary,
  type SpaceChildRoom,
} from '@trinity/data-access-rooms';
import {
  RoomNotificationsService,
  type RoomNotifyMode,
} from '@trinity/data-access-notifications';
import { type PresenceState } from '@trinity/util-matrix';
import { unreadBadgeLabel } from '../shared/unread-badge';
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
    HlmDropdownMenuRadio,
    HlmDropdownMenuRadioIndicator,
    HlmDropdownMenuSeparator,
    HlmDropdownMenuSub,
    HlmDropdownMenuSubTrigger,
  ],
  viewProviders: [
    provideIcons({
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
  private readonly roomsSvc = inject(RoomsService);
  private readonly presence = inject(PresenceService);
  private readonly roomNotifications = inject(RoomNotificationsService);

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
  /** Whether any room has unread messages — gates the header "Mark all as read". */
  readonly hasAnyUnread = computed(() => this.rooms().some((r) => r.hasUnread));

  /** The account badge for a room row (mixed view), or null when not badged. */
  badgeFor(accountId: string): { initial: string; name: string } | null {
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
  /** Pending invites surfaced in an "Invites" group above the channels. */
  readonly invites = this.invitesSvc.pendingInvites;
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
   * Owning-account badge per account id (mixed-account view): account id → {initial,
   * name}. Empty when not in mixed mode — room rows then show no badge.
   */
  readonly accountBadges = input<
    ReadonlyMap<string, { initial: string; name: string }>
  >(new Map());
  /**
   * The global account scope when the mixed toggle applies: `'this'` / `'all'`, or null to
   * hide the toggle (only one account signed in). Governs every view — Recent, Home's DMs,
   * the Rooms list and the rail's space pills all follow it, not just Recent.
   */
  readonly accountScope = input<'this' | 'all' | null>(null);
  /** The user changed the account scope via the header toggle. */
  readonly accountScopeChange = output<'this' | 'all'>();
  readonly selectRoom = output<string>();
  /** Header "+" on Home — raise the new-room / new-DM chooser. */
  readonly newChat = output<void>();
  /** Header "+" in a space — raise the create-a-channel flow. */
  readonly createRoom = output<void>();
  /** Header person-add in a space — raise the invite-to-space flow. */
  readonly inviteToSpace = output<void>();
  /** Header exit icon — raise the leave-this-space confirmation. */
  readonly leaveSpace = output<void>();
  /** Join a not-yet-joined child room or sub-space of the active space. */
  readonly joinRoom = output<SpaceChildRoom>();
  /** Remove (unlink) a joined channel from the active space, by room id. */
  readonly removeRoom = output<string>();
  /** Leave a joined room entirely (not just unlink from a space), by room id. */
  readonly leaveRoom = output<string>();
  /** Open a joined sub-space (select it in the rail), by room id. */
  readonly openChildSpace = output<string>();
  /** Accept / decline a pending invite by room id. */
  readonly acceptInvite = output<string>();
  readonly declineInvite = output<string>();
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
  readonly setNotifyMode = output<{ roomId: string; mode: RoomNotifyMode }>();
  /** Mark a single room read (from its ⋮ menu), by room id. */
  readonly markRead = output<string>();
  /** Mark every room read (header action). */
  readonly markAllRead = output<void>();

  /** Cap an unread count for a room-row badge, Discord-style ("99+"). */
  readonly badgeLabel = unreadBadgeLabel;

  /**
   * Live online status for a direct message's other participant, or null for a non-DM
   * room (which gets no presence dot). Reads the memoized per-user presence signal, so
   * the row updates when that user's presence changes.
   */
  presenceOf(room: RoomSummary): PresenceState | null {
    return room.directUserId
      ? this.presence.presenceFor(room.directUserId)()
      : null;
  }

  /** Fire-and-forget: flip the room's `m.favourite` tag via the rooms service. */
  toggleFavourite(room: RoomSummary): void {
    this.roomsSvc.setFavourite(room.id, !room.favourite);
  }

  /**
   * The room's current notification level, read fresh from its push rules to seed the
   * ⋮ menu's radio checks. Re-read each time the submenu opens (the write is delegated to
   * the host via {@link setNotifyMode}), so the check reflects the persisted preference.
   */
  notifyMode(roomId: string): RoomNotifyMode {
    return this.roomNotifications.modeFor(roomId);
  }
}
