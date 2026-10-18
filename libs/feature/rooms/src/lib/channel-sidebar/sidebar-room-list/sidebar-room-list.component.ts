import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
  viewChildren,
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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ContentReportingService } from '@trinity/data-access/room-administration';
import { InviteActionsService } from '../../rooms/invite-actions.service';
import type { RoomNotifyMode } from '@trinity/data-access/notifications';
import {
  SidebarRoomRowComponent,
  type SidebarRoomAction,
} from './sidebar-room-row/sidebar-room-row.component';
import { SidebarListWindow } from './sidebar-list-window';

/** One line of the windowed list: a section label, a divider or a room row. */
export type SidebarItem =
  | { readonly kind: 'category'; readonly key: string; readonly label: string }
  | { readonly kind: 'divider'; readonly key: string }
  | { readonly kind: 'room'; readonly key: string; readonly room: RoomSummary };

/**
 * The scrolling body of the channel sidebar: pending invites, the three room partitions
 * (favourites, other, low priority), the empty state, and the `trn-sidebar-room-row`s they render.
 * The parent keeps the header, the space menu and the space-children lists.
 *
 * The host is `display: contents` on purpose: it sits between `.sidebar__scroll` and its children,
 * and anything else would insert a box into the flex column that is scrolling.
 */
@Component({
  selector: 'trn-sidebar-room-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'sidebar-room-list.component.html',
  styleUrls: ['sidebar-room-list.component.scss'],
  host: { '[attr.aria-busy]': 'loading() ? "true" : null' },
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
  private readonly reporting = inject(ContentReportingService);
  private readonly inviteOpeners =
    viewChildren<ElementRef<HTMLElement>>('inviteOpen');
  /**
   * The invite row just answered. Focus moves on once its row is gone and the answer has
   * finished (`done`), so a "Report sent" dialog still open keeps it.
   */
  private readonly answeredInvite = signal<{
    readonly roomId: string;
    readonly index: number;
    readonly done: boolean;
  } | null>(null);
  private readonly inviteAnswers = inject(InviteActionsService, {
    optional: true,
  });
  private readonly destroyRef = inject(DestroyRef);

  private readonly topSpacer = viewChild<ElementRef<HTMLElement>>('topSpacer');
  private readonly itemHosts = viewChildren('line', { read: ElementRef });

  /** Compact rows use a 20px avatar; the avatar derives its dot and badge floors from it. */
  readonly avatarSize = computed(() =>
    this.roomListStyle() === 'compact' ? 20 : 36,
  );

  readonly rooms = input<readonly RoomSummary[]>([]);
  readonly invites = input<readonly PendingInvite[]>([]);
  readonly activeRoomId = input<string | null>(null);
  /**
   * Who is typing, per room id, excluding the local user. An INPUT and not a `RoomLibraryService`
   * read: `typingByRoom` is an instance field, which ng-mocks does not reflect, so a bare
   * `MockProvider(RoomLibraryService)` would leave it undefined and throw on every render.
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
   * Whether the parent's filter box is narrowing {@link rooms}. Only the empty state cares: an empty
   * list means "you have no rooms here" normally and "nothing matched" under a filter, and telling a
   * user with 40 rooms that they have none is worse than saying nothing.
   */
  readonly filterActive = input(false);
  /** The rooms are still loading (a selected space not listed yet): the empty state says so. */
  readonly loading = input(false);
  /**
   * The element that scrolls this list. With one, a long list renders only the lines in and near its
   * viewport, plus spacers, so the DOM stays bounded however many rooms the account has. Without one
   * (or with {@link SMALL_LIST_ITEMS} lines or fewer) every line renders.
   */
  readonly scroller = input<HTMLElement | null>(null);

  readonly selectRoom = output<{ roomId: string; accountId: string }>();
  /** Carries the owning account so a mixed-in row leaves on ITS account, not the active one. */
  readonly leaveRoom = output<{ roomId: string; accountId: string }>();
  readonly reportRoom = output<{ roomId: string; accountId: string }>();
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
  readonly declineAndReport = output<PendingInvite>();
  readonly favouriteChange = output<RoomSummary>();
  readonly priorityChange = output<RoomSummary>();

  /**
   * Favourite rooms (`m.favourite`), under a "Favourite" header. The service already sorts
   * favourite-first, so a stable partition keeps activity order within each group.
   */
  readonly favouriteRooms = computed(() =>
    this.rooms().filter((r) => r.favourite),
  );

  /**
   * Low-priority rooms (`m.lowpriority`), rendered last under their own header. Favourite wins when a
   * room carries both tags, matching `compareRoomSummaries`: the partition and the sort must agree,
   * or a room would render in one group while the keyboard walk found it in another.
   */
  readonly lowPriorityRooms = computed(() =>
    this.rooms().filter((r) => r.lowPriority && !r.favourite),
  );

  /** The rest of the rooms, rendered between the two groups. */
  readonly otherRooms = computed(() =>
    this.rooms().filter((r) => !r.favourite && !r.lowPriority),
  );

  /** Favourites, the rest and low priority as one list of lines, labels and dividers included. */
  readonly items = computed<readonly SidebarItem[]>(() => {
    const favourites = this.favouriteRooms();
    const others = this.otherRooms();
    const lowPriority = this.lowPriorityRooms();
    const items: SidebarItem[] = [];
    const rows = (rooms: readonly RoomSummary[]) => {
      for (const room of rooms)
        items.push({ kind: 'room', key: room.id, room });
    };
    if (favourites.length) {
      items.push({
        kind: 'category',
        key: 'category:favourites',
        label: 'Favourites',
      });
      rows(favourites);
      if (others.length)
        items.push({ kind: 'divider', key: 'divider:favourites' });
    }
    rows(others);
    if (lowPriority.length) {
      if (others.length || favourites.length) {
        items.push({ kind: 'divider', key: 'divider:low-priority' });
      }
      items.push({
        kind: 'category',
        key: 'category:low-priority',
        label: 'Low priority',
      });
      rows(lowPriority);
    }
    return items;
  });

  // Created after the signals it reads, so they exist when they are passed in.
  private readonly listWindow = new SidebarListWindow(
    this.items,
    this.scroller,
    this.invites,
    this.topSpacer,
    this.itemHosts,
  );
  readonly windowedItems = this.listWindow.windowedItems;
  readonly topPad = this.listWindow.topPad;
  readonly bottomPad = this.listWindow.bottomPad;

  /** Hidden once the invited account's server has said it takes no room reports. */
  canDeclineAndReport(invite: PendingInvite): boolean {
    return this.reporting.offers(invite.accountId, 'room');
  }

  answerInvite(
    invite: PendingInvite,
    index: number,
    action: 'decline' | 'decline-and-report',
  ): void {
    // Without a host that reports answers (a lone list), the click is the whole answer.
    this.answeredInvite.set({
      roomId: invite.roomId,
      index,
      done: !this.inviteAnswers,
    });
    (action === 'decline' ? this.declineInvite : this.declineAndReport).emit(
      invite,
    );
  }

  constructor() {
    this.inviteAnswers?.answered
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ roomId, declined }) => {
        const answered = this.answeredInvite();
        if (answered?.roomId !== roomId) return;
        this.answeredInvite.set(declined ? { ...answered, done: true } : null);
      });

    // The answered row's buttons vanish with it; land focus on the next invite, else the list.
    afterRenderEffect({
      write: () => {
        const invites = this.invites();
        const openers = this.inviteOpeners();
        const answered = this.answeredInvite();
        if (
          !answered?.done ||
          invites.some((i) => i.roomId === answered.roomId)
        )
          return;
        untracked(() => {
          this.answeredInvite.set(null);
          const active = document.activeElement;
          if (active && active !== document.body) return;
          // The list is windowed: this is the first rendered row, not necessarily the first room.
          const next =
            openers[Math.min(answered.index, openers.length - 1)]
              ?.nativeElement ??
            (
              this.itemHosts()[0]?.nativeElement as Element | undefined
            )?.querySelector<HTMLElement>('.channel');
          next?.focus();
        });
      },
    });
  }

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
      case 'report':
        return this.reportRoom.emit({ roomId, accountId });
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
