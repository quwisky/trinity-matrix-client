import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TrnIconComponent } from '@trinity/components/foundations';
import { type ThreadSummary } from '@trinity/data-access/timeline';

@Component({
  selector: 'trn-message-thread-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent],
  templateUrl: './message-thread-summary.component.html',
  styleUrl: './message-thread-summary.component.scss',
})
export class MessageThreadSummaryComponent {
  readonly summary = input.required<ThreadSummary>();
  readonly latestReplyLabel = input<string | null>(null);
  readonly open = output<void>();

  readonly label = computed(() => {
    const summary = this.summary();
    const count = summary.replyCount;
    const base = `View thread, ${count} ${count === 1 ? 'reply' : 'replies'}`;
    return summary.unreadCount > 0
      ? `${base}, ${summary.unreadCount} unread`
      : base;
  });
}
