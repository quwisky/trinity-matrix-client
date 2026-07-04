import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMessagesSquare } from '@ng-icons/lucide';
import { AvatarComponent, MessageToolbarComponent } from '@trinity/ui';
import type { MessageView, ThreadSummary } from '@trinity/core';
import { MessageReactionsComponent } from '../message-reactions/message-reactions.component';
import { MediaAttachmentComponent } from '../media-attachment/media-attachment.component';

/** A {@link MessageView} plus Discord-style grouping flag (own header vs continuation). */
export interface MessageRow extends MessageView {
  showHeader: boolean;
}

/**
 * One presentational message row, shared by the main timeline ({@link
 * SimpleMessageListComponent} / {@link VirtualMessageListComponent}) and the thread
 * view so all render identically — sender
 * header/continuation, reply preview, media/markdown/text body, reactions, the
 * hover toolbar, and (main timeline only) a thread indicator.
 *
 * Stateless: it raises intent outputs and leaves the orchestration (edit/reply
 * mode, sending, presenting the thread view) to its host. In `readOnly` mode the
 * hover toolbar and failed/retry affordance are suppressed (the view-only thread
 * panel), keeping reactions visible.
 */
@Component({
  selector: 'trn-message-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    DatePipe,
    NgIcon,
    MediaAttachmentComponent,
    MessageReactionsComponent,
    MessageToolbarComponent,
  ],
  viewProviders: [provideIcons({ lucideMessagesSquare })],
  templateUrl: './message-row.component.html',
  styleUrl: './message-row.component.scss',
})
export class MessageRowComponent {
  readonly row = input.required<MessageRow>();
  /** Thread summary for this row's event (main timeline only), else null. */
  readonly threadSummary = input<ThreadSummary | null>(null);
  /** Whether the current user may edit this message (own, confirmed, text). */
  readonly editable = input(false);
  /** Whether the current user may delete this message. */
  readonly deletable = input(false);
  /** Hide the hover toolbar + retry affordance (view-only thread panel). */
  readonly readOnly = input(false);
  /** Offer "Reply in thread" in the toolbar — false inside a thread (no nesting). */
  readonly canThread = input(true);

  /** A reaction key was chosen (quick-emoji toolbar or an existing reaction pill). */
  readonly react = output<string>();
  readonly replyMessage = output<void>();
  readonly copyMessage = output<void>();
  readonly editMessage = output<void>();
  readonly deleteMessage = output<void>();
  readonly retry = output<void>();
  /** The reply preview was clicked — jump to the quoted event id. */
  readonly jumpReply = output<string>();
  /** The thread indicator was clicked — open the thread for this root event id. */
  readonly openThread = output<string>();

  /** Accessible label for the thread indicator button (incl. any unread count). */
  threadLabel(summary: ThreadSummary): string {
    const count = summary.replyCount;
    const base = `View thread, ${count} ${count === 1 ? 'reply' : 'replies'}`;
    return summary.unreadCount > 0
      ? `${base}, ${summary.unreadCount} unread`
      : base;
  }
}
