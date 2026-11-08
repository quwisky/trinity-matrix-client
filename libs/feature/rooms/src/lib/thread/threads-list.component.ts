import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map, shareReplay, timer } from 'rxjs';
import { SidePanelComponent } from '../side-panel/side-panel.component';
import { SidePanelEmptyComponent } from '../side-panel/side-panel-empty.component';
import { AvatarComponent } from '@trinity/components/generic-content';
import { TrnBadge } from '@trinity/components/generic-content';
import { releaseInputTargetOnDestroy } from '@trinity/components/overlay';
import {
  ConversationRuntime,
  type ThreadParticipant,
  type ThreadSummary,
} from '@trinity/data-access/timeline';
import { DateTimeFormatService } from '@trinity/platform-native';
import { UnencryptedMarkComponent } from '../shared/unencrypted-mark/unencrypted-mark.component';

/** Participant avatars stacked under a row, after the root's author. */
const MAX_PARTICIPANTS = 3;

// Every mounted list shares a minute tick for its relative times.
const clock = timer(60_000, 60_000).pipe(
  map(() => Date.now()),
  shareReplay({ bufferSize: 1, refCount: true }),
);

/** A labelled run of rows: the unread threads, then the others. */
interface ThreadGroup {
  readonly key: 'unread' | 'all';
  readonly label: string;
  readonly threads: readonly ThreadSummary[];
}

/**
 * Threads-list panel: every thread in the active room, newest activity first, the unread ones
 * in their own group above the rest. Each row shows the root's author, its text, the unread
 * count, "Author · N replies · when" and the other participants.
 *
 * Presentational: it opens nothing itself. Tapping a row announces the chosen root id via
 * {@link ThreadsListComponent.selected} and the rooms page swaps the slot to a
 * {@link ThreadViewComponent}, so the two surfaces never stack.
 */
@Component({
  selector: 'trn-threads-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    UnencryptedMarkComponent,
    SidePanelComponent,
    SidePanelEmptyComponent,
    AvatarComponent,
    TrnBadge,
  ],
  templateUrl: './threads-list.component.html',
  styleUrl: './threads-list.component.scss',
})
export class ThreadsListComponent {
  private readonly threadProjection = inject(ConversationRuntime).threads;
  /** Relative times follow the reader's language through the app's format preference. */
  private readonly fmt = inject(DateTimeFormatService);
  private readonly now = toSignal(clock, { initialValue: Date.now() });

  /** The room whose threads are listed (used by the page to open a thread). */
  readonly roomId = input.required<string>();

  /** The user picked a thread: its root event id. */
  readonly selected = output<string>();
  /** The user closed the list without picking a thread. */
  readonly dismissed = output<void>();

  /** The active room's threads, newest activity first. */
  readonly threads = this.threadProjection.list;

  /** Unread threads first, under their own label; a group with no threads is left out. */
  protected readonly groups = computed<readonly ThreadGroup[]>(() => {
    const threads = this.threads();
    const unread = threads.filter((t) => t.unreadCount > 0);
    const read = threads.filter((t) => t.unreadCount === 0);
    const groups: ThreadGroup[] = [];
    if (unread.length) {
      groups.push({ key: 'unread', label: 'Unread', threads: unread });
    }
    if (read.length) {
      // "All" only while it really holds every thread.
      const label = unread.length ? 'Other threads' : 'All threads';
      groups.push({ key: 'all', label, threads: read });
    }
    return groups;
  });

  constructor() {
    // Closed after a press or key inside it, the panel would otherwise stay in memory,
    // detached, as the CDK's last input target until the next one.
    releaseInputTargetOnDestroy();
  }

  /** Announce the chosen thread root; the page decides what the slot shows next. */
  openThread(rootEventId: string): void {
    this.selected.emit(rootEventId);
  }

  /** Announce a close with no thread picked. */
  close(): void {
    this.dismissed.emit();
  }

  /** The root's author: the first participant once the root has loaded. */
  protected authorOf(summary: ThreadSummary): ThreadParticipant | null {
    return summary.rootSenderName ? (summary.participants[0] ?? null) : null;
  }

  /** Everyone else who took part, for the stacked avatars. */
  protected othersIn(summary: ThreadSummary): readonly ThreadParticipant[] {
    const author = this.authorOf(summary);
    return summary.participants
      .filter((p) => p.id !== author?.id)
      .slice(0, MAX_PARTICIPANTS);
  }

  /** "Ada · 12 replies · 2 min. ago", in the reader's language for the time. */
  protected metaLine(summary: ThreadSummary): string {
    const replies = `${summary.replyCount} ${summary.replyCount === 1 ? 'reply' : 'replies'}`;
    const when = this.fmt.relative(summary.latestActivityTs, this.now());
    return [summary.rootSenderName, replies, when]
      .filter((part) => !!part)
      .join(' · ');
  }

  /** Accessible label for a row's unread badge. */
  unreadLabel(summary: ThreadSummary): string {
    const n = summary.unreadCount;
    return summary.highlight
      ? `${n} unread ${n === 1 ? 'mention' : 'mentions'}`
      : `${n} unread`;
  }
}
