import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMessagesSquare, lucideShieldAlert } from '@ng-icons/lucide';
import {
  AvatarComponent,
  MessageToolbarComponent,
  type MessageAction,
  type MessageToolbarCaps,
} from '@trinity/ui';
import { type ThreadSummary } from '@trinity/data-access-timeline';
import {
  type MatrixLinkTarget,
  type MessageView,
  type ReceiptView,
} from '@trinity/util-matrix';
import { MessageReactionsComponent } from '../message-reactions/message-reactions.component';
import { MediaAttachmentComponent } from '../media-attachment/media-attachment.component';
import { SpoilerRevealDirective } from '../spoiler/spoiler-reveal.directive';
import { MatrixLinkDirective } from '../matrix-link/matrix-link.directive';
import { PollComponent } from '../poll/poll.component';
import { LinkPreviewComponent } from '../link-preview/link-preview.component';
import { LocationComponent } from '../location-share/location.component';
import { StickerComponent } from '../sticker/sticker.component';

/** A {@link MessageView} plus Discord-style grouping flag (own header vs continuation). */
export interface MessageRow extends MessageView {
  showHeader: boolean;
}

/** The per-row capability/state flags the row (and its toolbar) render from. */
export interface MessageRowCaps {
  /** Whether the current user may edit this message (own, confirmed, text). */
  editable: boolean;
  /** Whether the current user may delete this message. */
  deletable: boolean;
  /** Whether the current user may pin/unpin this message (room permission). */
  canPin: boolean;
  /** Whether this message is currently pinned. */
  pinned: boolean;
  /** Offer "Reply in thread" — false inside a thread (no nesting). */
  canThread: boolean;
  /** Hide the hover toolbar + retry affordance (view-only thread panel). */
  readOnly: boolean;
}

/** A user intent raised from a message row: the toolbar's actions plus row-local ones. */
export type MessageRowAction =
  MessageAction | { type: 'retry' } | { type: 'jump'; id: string };

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
    SpoilerRevealDirective,
    MatrixLinkDirective,
    PollComponent,
    LinkPreviewComponent,
    LocationComponent,
    StickerComponent,
  ],
  viewProviders: [provideIcons({ lucideMessagesSquare, lucideShieldAlert })],
  templateUrl: './message-row.component.html',
  styleUrl: './message-row.component.scss',
})
export class MessageRowComponent {
  readonly row = input.required<MessageRow>();
  /** Thread summary for this row's event (main timeline only), else null. */
  readonly threadSummary = input<ThreadSummary | null>(null);
  /** Per-row capabilities/state (edit/delete/pin permissions, pinned, read-only). */
  readonly caps = input<MessageRowCaps>({
    editable: false,
    deletable: false,
    canPin: false,
    pinned: false,
    canThread: true,
    readOnly: false,
  });

  /**
   * A user intent raised from this row — a toolbar action, a reaction, a retry, or a
   * jump-to-quoted-message. The host pairs it with `row` to run the effect.
   */
  readonly action = output<MessageRowAction>();

  /** A `matrix.to` permalink clicked in the message body, for the host to route in-app. */
  readonly matrixLink = output<MatrixLinkTarget>();

  /** A vote cast on this row's poll (the host sends the m.poll.response). */
  readonly pollVote = output<{ pollId: string; answerId: string }>();
  /** A request to close this row's poll (the host sends the m.poll.end). */
  readonly pollEnd = output<string>();

  /** Capabilities the overflow toolbar needs, projected from {@link caps}. */
  readonly toolbarCaps = computed<MessageToolbarCaps>(() => {
    const c = this.caps();
    return {
      canEdit: c.editable,
      canDelete: c.deletable,
      canPin: c.canPin,
      pinned: c.pinned,
      canThread: c.canThread,
    };
  });

  /** Accessible label for the thread indicator button (incl. any unread count). */
  threadLabel(summary: ThreadSummary): string {
    const count = summary.replyCount;
    const base = `View thread, ${count} ${count === 1 ? 'reply' : 'replies'}`;
    return summary.unreadCount > 0
      ? `${base}, ${summary.unreadCount} unread`
      : base;
  }

  /** Whether the "seen by" reader list is expanded (toggled from the receipt cluster). */
  readonly seenByOpen = signal(false);

  /** Accessible label for the "seen by" receipt avatars (the avatars are decorative). */
  seenByLabel(receipts: readonly ReceiptView[]): string {
    return `Seen by ${receipts.map((r) => r.name).join(', ')}`;
  }
}
