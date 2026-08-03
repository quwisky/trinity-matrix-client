import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowDownWideNarrow,
  lucideBell,
  lucideBellOff,
  lucideBellRing,
  lucideCheck,
  lucideCheckCheck,
  lucideCircleMinus,
  lucideDoorOpen,
  lucideEllipsisVertical,
  lucideHash,
  lucideMailOpen,
  lucideStar,
} from '@ng-icons/lucide';
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
import { AvatarComponent, type AccountBadge } from '@trinity/ui';
import { unreadBadgeLabel } from '../../shared/unread-badge';
import { RoomsService, type RoomSummary } from '@trinity/data-access/rooms';
import {
  RoomNotificationsService,
  type RoomNotifyMode,
} from '@trinity/data-access/notifications';
import { PresenceService } from '@trinity/data-access/profile';
import { type PresenceState } from '@trinity/util/matrix';
import { type PendingInvite } from '@trinity/data-access/invites';

/**
 * The scrolling body of the channel sidebar: pending invites, the favourite and
 * everything-else partitions, the empty state, and the row template both partitions render
 * through.
 *
 * Extracted from `ChannelSidebarComponent`, whose template was 561 lines — past the 250-300
 * refactor threshold in `.claude/rules/code-quality.md`, and the single region that every
 * room-list feature has to edit. The parent keeps the header, the space menu and the
 * space-children lists.
 *
 * The host is `display: contents` on purpose: this element sits between `.sidebar__scroll`
 * and its children, and anything else would insert a box into a flex column that is doing
 * the scrolling.
 */
@Component({
  selector: 'trn-sidebar-room-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'sidebar-room-list.component.html',
  styleUrls: ['sidebar-room-list.component.scss'],
  imports: [
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
      lucideArrowDownWideNarrow,
      lucideBell,
      lucideBellOff,
      lucideBellRing,
      lucideCheck,
      lucideCheckCheck,
      lucideCircleMinus,
      lucideDoorOpen,
      lucideEllipsisVertical,
      lucideHash,
      lucideMailOpen,
      lucideStar,
    }),
  ],
})
export class SidebarRoomListComponent {
  private readonly roomsSvc = inject(RoomsService);
  private readonly presence = inject(PresenceService);
  private readonly roomNotifications = inject(RoomNotificationsService);

  readonly rooms = input<RoomSummary[]>([]);
  readonly invites = input<readonly PendingInvite[]>([]);
  readonly activeRoomId = input<string | null>(null);
  readonly activeUserId = input<string | null>(null);
  readonly spaceActive = input(false);
  readonly accountBadges = input<ReadonlyMap<string, AccountBadge>>(new Map());

  readonly selectRoom = output<string>();
  /** Carries the owning account so a mixed-in row leaves on ITS account, not the active one. */
  readonly leaveRoom = output<{ roomId: string; accountId: string }>();
  readonly removeRoom = output<string>();
  /** Carries every owning account, so a merged row's level is written on all of them. */
  readonly setNotifyMode = output<{
    roomId: string;
    mode: RoomNotifyMode;
    accountIds: readonly string[];
  }>();
  readonly markRead = output<{
    roomId: string;
    accountIds: readonly string[];
  }>();
  readonly markUnread = output<{
    roomId: string;
    accountIds: readonly string[];
  }>();
  readonly acceptInvite = output<{ roomId: string; accountId: string }>();
  readonly declineInvite = output<{ roomId: string; accountId: string }>();

  /**
   * Favourite rooms (`m.favourite`), rendered under a "Favourite" header. The service
   * already sorts favourite-first, so a stable partition keeps activity order within
   * each group.
   */
  readonly favouriteRooms = computed(() =>
    this.rooms().filter((r) => r.favourite),
  );

  /**
   * Low-priority rooms (`m.lowpriority`), rendered last under their own header.
   *
   * Favourite wins when a room carries both tags, matching `compareRoomSummaries` — the
   * partition and the sort have to agree, or a room would render in one group while the
   * keyboard walk found it in another.
   */
  readonly lowPriorityRooms = computed(() =>
    this.rooms().filter((r) => r.lowPriority && !r.favourite),
  );

  /** The rest of the rooms, rendered between the two groups. */
  readonly otherRooms = computed(() =>
    this.rooms().filter((r) => !r.favourite && !r.lowPriority),
  );

  readonly badgeLabel = unreadBadgeLabel;

  badgeFor(accountId: string): AccountBadge | null {
    return this.accountBadges().get(accountId) ?? null;
  }

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

  /** Fire-and-forget: flip the room's `m.lowpriority` tag on every account joined to the
   * row, so a merged row's group does not depend on which account is active. */
  toggleLowPriority(room: RoomSummary): void {
    for (const accountId of room.accountIds) {
      this.roomsSvc.setLowPriority(room.id, !room.lowPriority, accountId);
    }
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
