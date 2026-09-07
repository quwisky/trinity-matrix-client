import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map, shareReplay, timer } from 'rxjs';
import { TrnIconComponent } from '@trinity/components/foundations';
import { type ThreadSummary } from '@trinity/data-access/timeline';

const relativeTime = new Intl.RelativeTimeFormat('en', { style: 'short' });
// All mounted previews share a minute tick; the last unmount releases the timer.
const clock = timer(60_000, 60_000).pipe(
  map(() => Date.now()),
  shareReplay({ bufferSize: 1, refCount: true }),
);

@Component({
  selector: 'trn-message-thread-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent],
  templateUrl: './message-thread-summary.component.html',
  styleUrl: './message-thread-summary.component.scss',
})
export class MessageThreadSummaryComponent {
  private readonly now = toSignal(clock, { initialValue: Date.now() });

  readonly summary = input.required<ThreadSummary>();
  readonly latestReplyLabel = input<string | null>(null);
  readonly open = output<void>();

  readonly relativeReplyTime = computed(() => {
    const timestamp = this.summary().latestReplyTs;
    if (!timestamp) return null;
    const minutes = Math.floor(Math.max(0, this.now() - timestamp) / 60_000);
    if (minutes === 0) return 'just now';
    if (minutes < 60) return relativeTime.format(-minutes, 'minute');
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return relativeTime.format(-hours, 'hour');
    return relativeTime.format(-Math.floor(hours / 24), 'day');
  });

  readonly label = computed(() => {
    const summary = this.summary();
    const count = summary.replyCount;
    const base = `View thread, ${count} ${count === 1 ? 'reply' : 'replies'}`;
    const unread =
      summary.unreadCount > 0
        ? `, ${summary.unreadCount} unread${summary.highlight ? ', including mentions' : ''}`
        : '';
    const preview = summary.latestReplyPreview
      ? `, ${summary.latestReplySenderName ? `${summary.latestReplySenderName}: ` : ''}${summary.latestReplyPreview}`
      : '';
    const time = this.relativeReplyTime();
    return `${base}${unread}${preview}${time ? `, ${time}` : ''}`;
  });
}
