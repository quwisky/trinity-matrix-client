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
import {
  lucideMessagesSquare,
  lucideShieldAlert,
  lucideShieldQuestion,
} from '@ng-icons/lucide';
import {
  AvatarComponent,
  MessageToolbarComponent,
  type MessageAction,
  type MessageToolbarCaps,
} from '@trinity/ui';
import { HlmTooltip } from '@trinity/helm/tooltip';
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
import { VoiceMessageComponent } from '../voice-message/voice-message.component';

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
  | MessageAction
  | { type: 'retry' }
  | { type: 'jump'; id: string }
  /** Show this message's earlier versions — raised by the "(edited)" marker, which is
   *  part of the row rather than the toolbar, so it stays out of `MessageAction`. */
  | { type: 'edit-history' }
  /** Show everyone who reacted — raised by the reaction pills (their trailing chip, or
   *  a long-pressed pill, which names its `key`; null asks for the whole list). */
  | { type: 'reactors'; key: string | null };

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
    VoiceMessageComponent,
    HlmTooltip,
  ],
  viewProviders: [
    provideIcons({
      lucideMessagesSquare,
      lucideShieldAlert,
      lucideShieldQuestion,
    }),
  ],
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

  /**
   * Whether to offer the "(edited)" marker, which opens the edit history.
   *
   * `edited` alone isn't enough. It comes from the SDK's replacing event, which survives
   * a redaction that arrived from the server (only a locally-applied one clears it), so a
   * deleted message can still claim to be edited — and its edits do still exist server-side.
   * A message we couldn't decrypt is excluded for the same reason: we can't show versions
   * of something we can't read.
   */
  readonly showEditedMarker = computed(() => {
    const row = this.row();
    return row.edited && row.kind !== 'redacted' && !row.decryptionFailed;
  });

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

  /** Icon shape for an authenticity shield's severity: a distinct glyph per level so the
   * warning (red) and caution (grey) are distinguishable by shape, not colour alone. */
  shieldIcon(level: 'grey' | 'red'): string {
    return level === 'red' ? 'lucideShieldAlert' : 'lucideShieldQuestion';
  }

  /** Whether the "seen by" reader list is expanded (toggled from the receipt cluster). */
  readonly seenByOpen = signal(false);

  /** Accessible label for the "seen by" receipt avatars (the avatars are decorative). */
  seenByLabel(receipts: readonly ReceiptView[]): string {
    return `Seen by ${receipts.map((r) => r.name).join(', ')}`;
  }
}
