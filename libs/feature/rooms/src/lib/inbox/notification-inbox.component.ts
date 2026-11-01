import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
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
 * and doesn't load by itself: an open and an account switch both leave it `idle`.
 */
@Component({
  selector: 'trn-notification-inbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    EmptyStateComponent,
    InboxRowComponent,
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
  private readonly scroller =
    viewChild.required<ElementRef<HTMLElement>>('scroller');
  /** The server's `read` lags and the list isn't live, so an opened row is held here. */
  private readonly openedIds = signal<ReadonlySet<string>>(new Set());
  private readonly lastOpenedId = signal<string | null>(null);
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
  readonly openRow = output<InboxRow>();
  readonly openSwitcher = output<void>();

  constructor() {
    this.inbox.connect();
    this.destroyRef.onDestroy(() => this.inbox.disconnect());
    effect(() => {
      if (this.inbox.status() === 'idle') untracked(() => this.refresh());
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
  }

  protected isUnread(row: InboxRow): boolean {
    return row.unread && !this.openedIds().has(row.eventId);
  }

  protected isCurrent(row: InboxRow): boolean {
    return (
      row.eventId === this.lastOpenedId() && row.roomId === this.activeRoomId()
    );
  }

  protected onRowOpened(row: InboxRow): void {
    this.openedIds.update((ids) => new Set(ids).add(row.eventId));
    this.lastOpenedId.set(row.eventId);
    this.openRow.emit(row);
  }

  private run(load: Observable<void>): void {
    load.pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
  }
}
