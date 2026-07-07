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
  HlmDropdownMenuLabel,
  HlmDropdownMenuSeparator,
  HlmDropdownMenuTrigger,
} from '@trinity/helm/dropdown-menu';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideCircleMinus,
  lucideCommand,
  lucideEllipsisVertical,
  lucideLogOut,
  lucidePlus,
  lucideSettings,
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
import { initialOf, type PresenceState } from '@trinity/util-matrix';
import { unreadBadgeLabel } from '../shared/unread-badge';

/** One signed-in account in the user-panel switcher: the profile plus its unread total. */
export interface AccountSummary extends UserProfile {
  /** Unread notification total for this account (drives the switcher badge). */
  unread: number;
}

/** Discord channel sidebar: space header, invites, room list, and the user panel. */
@Component({
  selector: 'trn-channel-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    NgIcon,
    NgTemplateOutlet,
    HlmDropdownMenuTrigger,
    HlmDropdownMenu,
    HlmDropdownMenuItem,
    HlmDropdownMenuLabel,
    HlmDropdownMenuSeparator,
  ],
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideCircleMinus,
      lucideCommand,
      lucideEllipsisVertical,
      lucideLogOut,
      lucidePlus,
      lucideSettings,
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
  /** First letter of the display name, for the user-panel avatar fallback. */
  readonly userInitial = computed(() => initialOf(this.user().displayName));
  /** Every signed-in account, for the switcher list in the user panel. */
  readonly accounts = input<AccountSummary[]>([]);
  /** The user id of the account currently in view (marked with a check). */
  readonly activeUserId = input<string | null>(null);
  /** User ids of accounts the server signed out that need re-authentication. */
  readonly reauthAccounts = input<readonly string[]>([]);
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
}
