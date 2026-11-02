import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  TrnActionAvailability,
  TrnButton,
  TrnIconButton,
  TrnTabsImports,
} from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import {
  EmptyStateComponent,
  TrnTooltip,
} from '@trinity/components/generic-content';
import {
  MentionIndexService,
  NotificationInboxService,
  type InboxRow,
  type InboxTab,
} from '@trinity/data-access/notifications';
import type { Observable } from 'rxjs';
import { InboxRowComponent } from './inbox-row/inbox-row.component';

/**
 * The inbox that fills the sidebar. The service holds the rows only while this is on screen,
 * and doesn't load by itself: an open, an account switch and a first sync that can name its
 * rows all leave it `idle`.
 */
@Component({
  selector: 'trn-notification-inbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    EmptyStateComponent,
    InboxRowComponent,
    TrnActionAvailability,
    TrnButton,
    TrnIconButton,
    TrnIconComponent,
    TrnTabsImports,
    TrnTooltip,
  ],
  templateUrl: './notification-inbox.component.html',
  styleUrl: './notification-inbox.component.scss',
})
export class NotificationInboxComponent {
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private savedScrollTop = 0;
  private readonly scroller =
    viewChild.required<ElementRef<HTMLElement>>('scroller');
  /** The server's `read` lags and the list isn't live, so an opened row is held here. */
  private readonly openedIds = signal<ReadonlySet<string>>(new Set());
  /** By room: a tap on a room since left opens nothing, so the open room's row stays current. */
  private readonly lastOpenedByRoom = signal<ReadonlyMap<string, string>>(
    new Map(),
  );
  private readonly summary = computed(() => {
    const count = this.rows().length;
    const unchecked = this.uncheckedNote();
    if (count === 0 && unchecked && !this.canLoadMore()) return unchecked;
    const noun = this.tab() === 'all' ? 'notification' : 'mention';
    const found =
      count === 0
        ? `No ${noun}s`
        : count === 1
          ? `1 ${noun}`
          : `${count} ${noun}s`;
    return this.canLoadMore() ? `${found} so far.` : `${found}.`;
  });

  protected readonly inbox = inject(NotificationInboxService);
  protected readonly recording = inject(MentionIndexService).recording;
  protected readonly tabs: readonly InboxTab[] = ['mentions', 'all'];
  protected readonly tab = signal<InboxTab>('mentions');
  protected readonly rows = computed(() =>
    this.tab() === 'all' ? this.inbox.all() : this.inbox.mentions(),
  );
  protected readonly canLoadMore = computed(() =>
    this.tab() === 'all' ? this.inbox.serverHasMore() : this.inbox.hasMore(),
  );
  protected readonly uncheckedNote = computed(() => {
    const count = this.inbox.uncheckedCount();
    if (this.tab() !== 'mentions' || count === 0) return null;
    return count === 1
      ? "1 message couldn't be checked because this device doesn't have its keys."
      : `${count} messages couldn't be checked because this device doesn't have their keys.`;
  });
  protected readonly limitNote = computed(() => {
    const load = this.inbox.lastLoad();
    return this.tab() === 'mentions' &&
      load?.tab === 'mentions' &&
      load.kind === 'limit' &&
      load.checked > 0
      ? `Checked ${load.checked} more notifications and found no more mentions.`
      : null;
  });
  protected readonly announcement = computed(() => {
    const status = this.inbox.status();
    if (status === 'loading') return 'Loading your inbox…';
    if (status === 'failed') return "Couldn't load your inbox";
    if (status === 'idle') return '';
    if (this.inbox.serverListFailed())
      return "Couldn't load your server's list.";
    return this.limitNote() ?? this.summary();
  });

  readonly activeRoomId = input<string | null>(null);
  readonly showSwitcher = input(false);
  /** The phone's room fills the screen, hiding this pane with `display: none`. */
  readonly paneHidden = input(false);
  readonly openRow = output<InboxRow>();
  readonly openSwitcher = output<void>();

  constructor() {
    this.inbox.connect();
    this.destroyRef.onDestroy(() => this.inbox.disconnect());
    effect(() => {
      if (this.inbox.status() === 'idle') untracked(() => this.refresh());
    });
    // Load more goes away on the last page, which would drop focus to the page.
    effect(() => {
      if (!this.canLoadMore()) untracked(() => this.keepFocusInPanel());
    });
    // Not every engine keeps a scroll position through `display: none`.
    effect(() => {
      if (this.paneHidden()) return;
      afterNextRender(
        () => {
          this.scroller().nativeElement.scrollTop = this.savedScrollTop;
        },
        { injector: this.injector },
      );
    });
  }

  protected refresh(): void {
    this.run(this.inbox.refresh());
  }

  /** Try again goes away as the load starts, which would drop focus to the page. */
  protected tryAgain(panel: HTMLElement): void {
    panel.focus();
    this.refresh();
  }

  protected loadMore(): void {
    this.run(this.inbox.loadMore(this.tab()));
  }

  protected selectTab(tab: string | undefined): void {
    this.tab.set(tab === 'all' ? 'all' : 'mentions');
    this.scroller().nativeElement.scrollTop = 0;
    this.savedScrollTop = 0;
  }

  protected onScroll(): void {
    if (!this.paneHidden()) {
      this.savedScrollTop = this.scroller().nativeElement.scrollTop;
    }
  }

  protected isUnread(row: InboxRow): boolean {
    return row.unread && !this.openedIds().has(row.eventId);
  }

  protected isCurrent(row: InboxRow): boolean {
    return (
      row.roomId === this.activeRoomId() &&
      this.lastOpenedByRoom().get(row.roomId) === row.eventId
    );
  }

  protected onRowOpened(row: InboxRow): void {
    this.openedIds.update((ids) => new Set(ids).add(row.eventId));
    this.lastOpenedByRoom.update((rooms) =>
      new Map(rooms).set(row.roomId, row.eventId),
    );
    this.openRow.emit(row);
  }

  private keepFocusInPanel(): void {
    const focused = document.activeElement;
    const panel = focused
      ?.closest<HTMLElement>('.inbox__more')
      ?.closest<HTMLElement>('[role="tabpanel"]');
    if (!panel) return;
    const lastRow = Array.from(
      panel.querySelectorAll<HTMLElement>('[data-testid="inbox-row"]'),
    ).at(-1);
    (lastRow ?? panel).focus();
  }

  private run(load: Observable<void>): void {
    load.pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
  }
}
