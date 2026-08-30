import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import {
  TrnActionAvailability,
  TrnIconButton,
} from '@trinity/components/button';
import { TrnTooltip } from '@trinity/components/tooltip';
import {
  TrnDropdownMenu,
  TrnDropdownMenuItem,
  TrnDropdownMenuItemSubIndicatorComponent,
  TrnDropdownMenuRadio,
  TrnDropdownMenuRadioIndicatorComponent,
  TrnDropdownMenuSeparator,
  TrnDropdownMenuSub,
  TrnDropdownMenuSubTrigger,
  TrnDropdownMenuTrigger,
} from '@trinity/components/overlay';
import { EmptyStateComponent } from '@trinity/components/empty-state';
import { AvatarComponent, type AccountBadge } from '@trinity/components/avatar';
import { unreadBadgeLabel } from '../../shared/unread-badge';
import {
  RoomLibraryService,
  type RoomSummary,
} from '@trinity/data-access/room-library';
import {
  RoomNotificationsService,
  type RoomNotifyDisplayMode,
  type RoomNotifyMode,
} from '@trinity/data-access/notifications';
import { PresenceService } from '@trinity/data-access/profile';
import { formatTypingNotice, type PresenceState } from '@trinity/util/matrix';
import { type PendingInvite } from '@trinity/data-access/room-library';
import { TrnIconComponent } from '@trinity/components/icon';
import { forkJoin } from 'rxjs';

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
    TrnIconButton,
    TrnActionAvailability,
    TrnTooltip,
    EmptyStateComponent,
    AvatarComponent,
    TrnIconComponent,
    NgTemplateOutlet,
    TrnDropdownMenuTrigger,
    TrnDropdownMenu,
    TrnDropdownMenuItem,
    TrnDropdownMenuItemSubIndicatorComponent,
    TrnDropdownMenuRadio,
    TrnDropdownMenuRadioIndicatorComponent,
    TrnDropdownMenuSeparator,
    TrnDropdownMenuSub,
    TrnDropdownMenuSubTrigger,
  ],
})
export class SidebarRoomListComponent {
  private readonly roomsSvc = inject(RoomLibraryService);
  private readonly presence = inject(PresenceService);
  private readonly roomNotifications = inject(RoomNotificationsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rooms = input<RoomSummary[]>([]);
  readonly invites = input<readonly PendingInvite[]>([]);
  readonly activeRoomId = input<string | null>(null);
  /**
   * Who is typing, per room id, excluding the local user.
   *
   * An INPUT and not a `RoomLibraryService` read: `typingByRoom` is an instance field, which
   * ng-mocks does not reflect, so a bare `MockProvider(RoomLibraryService)` would leave it
   * undefined and throw here on every render — and one helper in
   * `channel-sidebar.component.spec.ts` backs 85 of them.
   */
  readonly typingByRoom = input<Readonly<Record<string, readonly string[]>>>(
    {},
  );
  readonly activeUserId = input<string | null>(null);
  readonly spaceActive = input(false);
  readonly canCurateSpace = input(false);
  readonly curateSpaceReason = input<string | null>(null);
  readonly accountBadges = input<ReadonlyMap<string, AccountBadge>>(new Map());
  /**
   * Whether the parent's filter box is narrowing {@link rooms}. Only the empty state cares:
   * an empty list means "you have no rooms here" normally and "nothing matched" under a
   * filter, and telling a user with 40 rooms that they have none is worse than saying
   * nothing.
   */
  readonly filterActive = input(false);

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

  /** "X is typing" for a room's preview line, or `''` when nobody in it is. */
  typingIn(roomId: string): string {
    return formatTypingNotice(this.typingByRoom()[roomId] ?? []);
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

  /** Flip the room's `m.lowpriority` tag on every account joined to the merged row. */
  toggleLowPriority(room: RoomSummary): void {
    forkJoin(
      room.accountIds.map((accountId) =>
        this.roomsSvc.setLowPriority(room.id, !room.lowPriority, accountId),
      ),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) =>
          console.error('Could not update room priority', error),
      });
  }

  /** Flip the room's `m.favourite` tag on every account joined to the merged row. */
  toggleFavourite(room: RoomSummary): void {
    forkJoin(
      room.accountIds.map((accountId) =>
        this.roomsSvc.setFavourite(room.id, !room.favourite, accountId),
      ),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) =>
          console.error('Could not update room favourite', error),
      });
  }

  /**
   * The room's current notification level, read fresh from its push rules to seed the
   * ⋮ menu's radio checks. Re-read each time the submenu opens (the write is delegated to
   * the host via {@link setNotifyMode}), so the check reflects the persisted preference.
   */
  notifyMode(room: RoomSummary): RoomNotifyDisplayMode {
    return this.roomNotifications.modeForAccounts(room.id, room.accountIds);
  }
}
