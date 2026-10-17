import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
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
import {
  buildPrefixSums,
  computeWindow,
  scrollCompensation,
  type HeightChange,
  type WindowResult,
} from '../../message-list/virtual-window';

/** One line of the windowed list: a section label, a divider or a room row. */
export type SidebarItem =
  | { readonly kind: 'category'; readonly key: string; readonly label: string }
  | { readonly kind: 'divider'; readonly key: string }
  | { readonly kind: 'room'; readonly key: string; readonly room: RoomSummary };

/** At or below this many lines, render every one (windowing is not worth it). */
const SMALL_LIST_ITEMS = 80;

/** Rendered beyond the viewport on each side, so a fast scroll does not show blanks. */
const OVERSCAN_PX = 400;

/** A room row's height before any has been measured: a two-line row at default density. */
const ESTIMATED_ROW_PX = 52;

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

  // Windowing state. `scrollTop` and `viewportH` come from the scroller; `regionTop` is where the
  // windowed lines start inside it (below the invites); `measured` keeps each rendered line's real
  // height, bumping `heightVersion` when one changes.
  private readonly scrollTop = signal(0);
  private readonly viewportH = signal(0);
  private readonly regionTop = signal(0);
  private readonly heightVersion = signal(0);
  private readonly measured = new Map<string, number>();
  private readonly observed = new Map<Element, string>();
  private itemObserver?: ResizeObserver;
  private readonly topSpacer = viewChild<ElementRef<HTMLElement>>('topSpacer');
  private readonly itemHosts = viewChildren('line', { read: ElementRef });

  private readonly ids = computed(() => this.items().map((item) => item.key));

  /** Measured room rows' typical height, standing in for rows not rendered yet. */
  private readonly estimate = computed(() => {
    this.heightVersion();
    let sum = 0;
    let count = 0;
    for (const [key, height] of this.measured) {
      if (key.includes(':')) continue; // labels and dividers are not room rows
      sum += height;
      count++;
    }
    return count ? sum / count : ESTIMATED_ROW_PX;
  });

  private readonly prefix = computed(() => {
    this.heightVersion();
    return buildPrefixSums(this.ids(), {
      measured: this.measured,
      estimate: this.estimate(),
    });
  });

  private readonly windowResult = computed<WindowResult>(() =>
    computeWindow(
      {
        ids: this.ids(),
        heights: { measured: this.measured, estimate: this.estimate() },
        scrollTop: Math.max(0, this.scrollTop() - this.regionTop()),
        viewportHeight: this.viewportH(),
        overscanPx: OVERSCAN_PX,
        pinBottom: false,
        smallListThreshold: SMALL_LIST_ITEMS,
        enabled: this.scroller() !== null && this.viewportH() > 0,
      },
      this.prefix(),
    ),
  );

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

  /** The lines actually rendered. */
  readonly windowedItems = computed(() => {
    const { startIndex, endIndex } = this.windowResult();
    const all = this.items();
    if (endIndex < 0) return [];
    return startIndex === 0 && endIndex === all.length - 1
      ? all
      : all.slice(startIndex, endIndex + 1);
  });
  readonly topPad = computed(() => this.windowResult().topPadPx);
  readonly bottomPad = computed(() => this.windowResult().bottomPadPx);

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

    // Follow the scroller. A plain listener rather than a template binding, so a scroll that keeps the
    // same lines rendered costs one signal write and a cheap recompute, not a change-detection pass per event.
    effect((onCleanup) => {
      const el = this.scroller();
      if (!el) return;
      const onScroll = () => this.scrollTop.set(el.scrollTop);
      el.addEventListener('scroll', onScroll, { passive: true });
      this.viewportH.set(el.clientHeight);
      this.scrollTop.set(el.scrollTop);
      let viewport: ResizeObserver | undefined;
      if (typeof ResizeObserver !== 'undefined') {
        viewport = new ResizeObserver(() => {
          this.viewportH.set(el.clientHeight);
          this.measureRegionTop();
        });
        viewport.observe(el);
      }
      onCleanup(() => {
        el.removeEventListener('scroll', onScroll);
        viewport?.disconnect();
      });
    });

    // Invites render above the windowed lines; when they come or go, the lines move.
    afterRenderEffect({
      read: () => {
        this.invites(); // tracked: invites render above the windowed lines
        untracked(() => this.measureRegionTop());
      },
    });

    // Measure the rendered lines; stop measuring ones that left the window.
    afterRenderEffect({
      read: () => this.reconcileObserved(this.itemHosts()),
    });

    this.destroyRef.onDestroy(() => this.itemObserver?.disconnect());
  }

  /**
   * Where the windowed lines start inside the scroller. Read on resize and when the invites change,
   * not per scroll: the offset does not move when the list scrolls.
   */
  private measureRegionTop(): void {
    const el = this.scroller();
    const spacer = this.topSpacer()?.nativeElement;
    if (!el || !spacer) return;
    this.regionTop.set(
      spacer.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop,
    );
  }

  /** The box to measure for one rendered line; a row's host is `display: contents`. */
  private measureTarget(host: Element): Element | null {
    return host.tagName === 'TRN-SIDEBAR-ROOM-ROW'
      ? host.firstElementChild
      : host;
  }

  private reconcileObserved(hosts: readonly ElementRef<Element>[]): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.itemObserver ??= new ResizeObserver((entries) =>
      this.onItemsResized(entries),
    );
    const seen = new Set<Element>();
    for (const { nativeElement } of hosts) {
      const key = nativeElement.getAttribute('data-sidebar-key');
      const target = this.measureTarget(nativeElement);
      if (!key || !target) continue;
      seen.add(target);
      if (!this.observed.has(target)) {
        this.observed.set(target, key);
        this.itemObserver.observe(target);
      }
    }
    for (const [target] of this.observed) {
      if (!seen.has(target)) {
        this.itemObserver.unobserve(target);
        this.observed.delete(target);
      }
    }
  }

  /** Record real heights, keeping the visible lines still when one above them changes. */
  private onItemsResized(entries: readonly ResizeObserverEntry[]): void {
    const el = this.scroller();
    const prefix = untracked(this.prefix);
    const ids = untracked(this.ids);
    const estimate = untracked(this.estimate);
    const changes: HeightChange[] = [];
    for (const entry of entries) {
      const key = this.observed.get(entry.target);
      if (key === undefined) continue;
      const height =
        entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      const prior = this.measured.get(key);
      if (height <= 0 || height === prior) continue;
      this.measured.set(key, height);
      const index = ids.indexOf(key);
      if (index >= 0) {
        changes.push({ index, prior: prior ?? estimate, next: height });
      }
    }
    if (!changes.length) return;
    if (el) {
      const top = el.scrollTop;
      const delta = scrollCompensation(
        changes,
        prefix,
        top,
        untracked(this.regionTop),
      );
      if (delta !== 0) {
        el.scrollTop = Math.max(0, top + delta);
        this.scrollTop.set(el.scrollTop);
      }
    }
    this.heightVersion.update((v) => v + 1);
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
