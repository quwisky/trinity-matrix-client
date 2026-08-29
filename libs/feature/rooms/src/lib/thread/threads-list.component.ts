import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
} from '@angular/core';
import { DateTimeFormatService } from '@trinity/platform-native';
import { EmptyStateComponent } from '@trinity/components/empty-state';
import { AvatarComponent } from '@trinity/components/avatar';
import { TrnButton } from '@trinity/components/button';
import { TrnTooltip } from '@trinity/components/tooltip';
import { TrnIconComponent } from '@trinity/components/icon';
import {
  ConversationRuntime,
  type ThreadSummary,
} from '@trinity/data-access/timeline';

/** Most participant avatars shown per row before the "+N" overflow chip. */
const MAX_AVATARS = 4;

/**
 * Threads-list panel: every thread in the active room, newest activity first,
 * each row showing the root preview, reply count, last-activity time, a
 * participant avatar cluster, and an unread badge. Reads the live
 * Conversation Runtime's live thread list (already projected for the active room),
 * so it reacts to new threads, replies, and unread changes.
 *
 * Presentational: rendered in the rooms shell's right-hand panel slot, with `roomId`
 * as a signal input. It opens nothing itself — tapping a row announces the chosen root
 * id via {@link ThreadsListComponent.selected} and the rooms page swaps the slot to a
 * {@link ThreadViewComponent}, keeping this component free of any thread-open
 * dependency (and the two surfaces from stacking).
 */
@Component({
  selector: 'trn-threads-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    EmptyStateComponent,
    TrnIconComponent,
    AvatarComponent,
    TrnButton,
    TrnTooltip,
  ],
  templateUrl: './threads-list.component.html',
  styleUrl: './threads-list.component.scss',
})
export class ThreadsListComponent {
  /** Timestamps go through the app-wide format preference, never a DatePipe. */
  readonly fmt = inject(DateTimeFormatService);

  private readonly threadProjection = inject(ConversationRuntime).threads;

  /** The room whose threads are listed (used by the page to open a thread). */
  readonly roomId = input.required<string>();

  /** The user picked a thread: its root event id. */
  readonly selected = output<string>();
  /** The user closed the list without picking a thread. */
  readonly dismissed = output<void>();

  /** The active room's threads, newest activity first. */
  readonly threads = this.threadProjection.list;

  /** Avatars shown per row, capped — the rest collapse into a "+N" chip. */
  readonly maxAvatars = MAX_AVATARS;

  /** Announce the chosen thread root; the page decides what the slot shows next. */
  openThread(rootEventId: string): void {
    this.selected.emit(rootEventId);
  }

  /** Announce a close with no thread picked. */
  close(): void {
    this.dismissed.emit();
  }

  /** Accessible label for a row's unread badge. */
  unreadLabel(summary: ThreadSummary): string {
    return summary.highlight
      ? `${summary.unreadCount} unread mentions`
      : `${summary.unreadCount} unread`;
  }
}
