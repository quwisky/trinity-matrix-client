import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { TrnIconButton } from '@trinity/components/controls';
import {
  AvatarComponent,
  EmptyStateComponent,
  TrnTooltip,
  type AccountBadge,
} from '@trinity/components/generic-content';
import { TrnIconComponent } from '@trinity/components/foundations';
import {
  ROOM_LIST_STYLE,
  type PendingInvite,
  type RoomSummary,
} from '@trinity/data-access/room-library';
import type { RoomNotifyMode } from '@trinity/data-access/notifications';
import {
  SidebarRoomRowComponent,
  type SidebarRoomAction,
} from './sidebar-room-row/sidebar-room-row.component';

/**
 * The scrolling body of the channel sidebar: pending invites, the three room partitions
 * (favourites, other, low priority), the empty state, and the `trn-sidebar-room-row`s
 * those partitions render.
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
    TrnTooltip,
    EmptyStateComponent,
    AvatarComponent,
    TrnIconComponent,
    SidebarRoomRowComponent,
  ],
})
export class SidebarRoomListComponent {
  private readonly roomListStyle = inject(ROOM_LIST_STYLE);

  /** Compact rows use a 20px avatar; the avatar derives its dot and badge floors from it. */
  readonly avatarSize = computed(() =>
    this.roomListStyle() === 'compact' ? 20 : 36,
  );

  readonly rooms = input<readonly RoomSummary[]>([]);
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

  readonly selectRoom = output<{ roomId: string; accountId: string }>();
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
  readonly previewInvite = output<PendingInvite>();
  readonly acceptInvite = output<PendingInvite>();
  readonly declineInvite = output<PendingInvite>();
  readonly favouriteChange = output<RoomSummary>();
  readonly priorityChange = output<RoomSummary>();

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

  badgeFor(accountId: string): AccountBadge | null {
    return this.accountBadges().get(accountId) ?? null;
  }

  onRoomAction(action: SidebarRoomAction): void {
    const { room } = action;
    const { id: roomId, accountId, accountIds } = room;
    switch (action.kind) {
      case 'select':
        return this.selectRoom.emit({ roomId, accountId });
      case 'leave':
        return this.leaveRoom.emit({ roomId, accountId });
      case 'remove':
        return this.removeRoom.emit(roomId);
      case 'mark-read':
        return this.markRead.emit({ roomId, accountIds });
      case 'mark-unread':
        return this.markUnread.emit({ roomId, accountIds });
      case 'favourite':
        return this.favouriteChange.emit(room);
      case 'low-priority':
        return this.priorityChange.emit(room);
      case 'notify':
        return this.setNotifyMode.emit({
          roomId,
          accountIds,
          mode: action.mode,
        });
      default:
        action satisfies never;
    }
  }
}
