import {
  DestroyRef,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DateTimeFormatService } from '@trinity/platform-native';
import { AvatarComponent } from '@trinity/components/avatar';
import {
  MessageToolbarComponent,
  type MessageAction,
  type MessageToolbarCaps,
} from '@trinity/components/message-toolbar';
import { TrnTooltip } from '@trinity/components/tooltip';
import { type ThreadSummary } from '@trinity/data-access/timeline';
import {
  type MatrixLinkTarget,
  type MessageView,
  type ReceiptView,
} from '@trinity/util/matrix';
import { MessageReactionsComponent } from '../message-reactions/message-reactions.component';
import { MediaAttachmentComponent } from '../media-attachment/media-attachment.component';
import { SpoilerRevealDirective } from '../spoiler/spoiler-reveal.directive';
import { MatrixLinkDirective } from '../matrix-link/matrix-link.directive';
import { PollComponent } from '../poll/poll.component';
import { LinkPreviewComponent } from '../link-preview/link-preview.component';
import { LocationComponent } from '../location-share/location.component';
import { VoiceMessageComponent } from '../voice-message/voice-message.component';
import { TrnIconComponent, type TrnIconName } from '@trinity/components/icon';

/** A {@link MessageView} plus the presentation state the list derives for it. */
export interface MessageRow extends MessageView {
  /** Discord-style grouping: own header, or a continuation of the row above. */
  showHeader: boolean;
  /**
   * Label for a day separator rendered ABOVE this row ("Today"/"Yesterday"/a date), or
   * absent when this row does not begin a new local calendar day.
   *
   * The finished label rather than a flag or an epoch, because at midnight a row that read
   * "Today" becomes "Yesterday" while both of those stay identical — the list's row cache
   * would hit, hand back the same object, and the OnPush row would never re-render. Making
   * the label the cached value means a rollover invalidates the row for free.
   */
  daySeparator?: string | null;
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
  /** Whether this message has text worth pulling into the composer as a quote. */
  canQuote: boolean;
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
  /** Show everyone who reacted — raised by the reaction pills' trailing chip. */
  | { type: 'reactors' };

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
/** How long a press has to be held before it counts as one, in milliseconds. */
const LONG_PRESS_MS = 500;
/** How far the pointer may drift before the press is a scroll instead. */
const LONG_PRESS_SLOP_PX = 10;

@Component({
  selector: 'trn-message-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    TrnIconComponent,
    MediaAttachmentComponent,
    MessageReactionsComponent,
    MessageToolbarComponent,
    SpoilerRevealDirective,
    MatrixLinkDirective,
    PollComponent,
    LinkPreviewComponent,
    LocationComponent,
    VoiceMessageComponent,
    TrnTooltip,
  ],
  templateUrl: './message-row.component.html',
  styleUrl: './message-row.component.scss',
})
export class MessageRowComponent {
  /** Timestamps go through the app-wide format preference, never a DatePipe. */
  readonly fmt = inject(DateTimeFormatService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly toolbar = viewChild(MessageToolbarComponent);
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressOrigin: { x: number; y: number } | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => this.cancelLongPress());
  }

  /**
   * Right-click opens the message's own actions instead of the browser's.
   *
   * Not suppressed over a selection: a user who has highlighted part of a message is asking
   * for Copy, and taking that menu away to offer our own would be a downgrade. The native
   * menu is only prevented where this row actually handles the event.
   */
  onContextMenu(event: MouseEvent): void {
    if (this.hasTextSelection()) {
      return;
    }
    const bar = this.toolbar();
    if (!bar) {
      return; // read-only rows and system events have no actions to offer
    }
    event.preventDefault();
    bar.openMoreMenu();
  }

  /**
   * Touch has no right-click, so a long press stands in for it — the same actions, reached
   * the way every other app on the device reaches them.
   */
  onPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' || !this.toolbar()) {
      return;
    }
    this.longPressOrigin = { x: event.clientX, y: event.clientY };
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      if (!this.hasTextSelection()) {
        this.toolbar()?.openMoreMenu();
      }
    }, LONG_PRESS_MS);
  }

  /**
   * A press that travels is a scroll, and a timeline is mostly scrolled. Cancelling on
   * movement is what keeps the menu from firing at the end of a flick.
   */
  onPointerMove(event: PointerEvent): void {
    const origin = this.longPressOrigin;
    if (!origin || this.longPressTimer === null) {
      return;
    }
    const travelled =
      Math.abs(event.clientX - origin.x) + Math.abs(event.clientY - origin.y);
    if (travelled > LONG_PRESS_SLOP_PX) {
      this.cancelLongPress();
    }
  }

  /** Lifting, cancelling, or leaving all end the press without opening anything. */
  cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.longPressOrigin = null;
  }

  /** Whether the user has text selected — their selection, their menu. */
  private hasTextSelection(): boolean {
    return (document.getSelection()?.toString().trim().length ?? 0) > 0;
  }

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
    canQuote: false,
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
      canQuote: c.canQuote,
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
  shieldIcon(level: 'grey' | 'red'): TrnIconName {
    return level === 'red' ? 'shield-alert' : 'shield-question';
  }

  /** Whether the "seen by" reader list is expanded (toggled from the receipt cluster). */
  readonly seenByOpen = signal(false);

  /** Accessible label for the "seen by" receipt avatars (the avatars are decorative). */
  seenByLabel(receipts: readonly ReceiptView[]): string {
    return `Seen by ${receipts.map((r) => r.name).join(', ')}`;
  }
}
