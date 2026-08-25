import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DateTimeFormatService, isMobileOs } from '@trinity/platform-native';
import { AvatarComponent } from '@trinity/components/avatar';
import {
  MessageToolbarComponent,
  type MessageAction,
  type MessageToolbarCaps,
} from '@trinity/components/message-toolbar';
import { TrnTooltip } from '@trinity/components/tooltip';
import { type ThreadSummary } from '@trinity/data-access/timeline';
import { type MessageView, type ReceiptView } from '@trinity/util/matrix';
import { MessageReactionsComponent } from '../message-reactions/message-reactions.component';
import { MediaAttachmentComponent } from '../media-attachment/media-attachment.component';
import { SpoilerRevealDirective } from '../spoiler/spoiler-reveal.directive';
import {
  type MatrixLinkClick,
  MatrixLinkDirective,
} from '../matrix-link/matrix-link.directive';
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

/** How long a press has to be held before it counts as one, in milliseconds. */
const LONG_PRESS_MS = 500;
/** How far the pointer may drift before the press is a scroll instead. */
const LONG_PRESS_SLOP_PX = 10;

/**
 * How far in from either viewport edge a message swipe refuses to START.
 *
 * Both competitors are viewport-anchored, and neither can be argued with once it has the
 * gesture: the shell's drawer opens from within `EDGE_ZONE_PX` of the right edge, and iOS and
 * Android own both edges with recognisers `touch-action` does not govern — WKWebView's are
 * outside CSS entirely, which `MainViewController.swift` records. So the only lever is to
 * refuse to arm there, measured at `pointerdown` because that is the only moment the decision
 * can be made without having already competed.
 *
 * Wider than the drawer's zone and wider than the platform regions, whose widths Apple and
 * Google do not publish — chosen with margin rather than derived. `message-row.swipe.spec.ts`
 * pins that it is never narrower than the drawer's; a device is what confirms it clears the
 * platform's.
 */
export const SWIPE_DEAD_ZONE_PX = 32;

/** How far a row must travel, as a fraction of its own width, before the action commits. */
const SWIPE_COMMIT_FRACTION = 0.25;

/** How far the pointer may drift vertically before the drag is a scroll instead. */
const SWIPE_VERTICAL_SLOP_PX = 12;

/** Which way a row is dragged to act on it, as resolved by whoever renders the row. */
export type SwipeDirection = 'off' | 'left' | 'right';

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

  private readonly host = inject(ElementRef<HTMLElement>);

  private readonly toolbar = viewChild(MessageToolbarComponent);
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressOrigin: { x: number; y: number } | null = null;
  private dismissReveal: (() => void) | null = null;

  /**
   * Whether this row's action bar is pinned open, which is how touch reaches it.
   *
   * The bar is revealed on hover, and a touchscreen has no hover. It used to be forced open
   * on every row under `@media (hover: none)` — which is why each row permanently wore a
   * toolbar — and removing that is what made the timeline quiet. But the long press that
   * replaced it opens the OVERFLOW menu, and Reply, Add reaction and Reply in thread are not
   * in that menu: they are the bar's own buttons. So the long press reveals the bar itself,
   * and its "⋯" still reaches everything else. One row at a time, gone on the next tap.
   */
  readonly revealed = signal(false);

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.cancelLongPress();
      // A row destroyed mid-drag — a redaction, an edit, the local-echo id swap, or simply
      // scrolling out of the virtual window — would otherwise leak its pointer capture.
      this.cancelSwipe();
      this.hideToolbar();
    });
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
    // A right-click on a link or an attachment wants the BROWSER's menu — "Open link in new
    // tab", "Save image as…". Those live nowhere else, so taking them away to offer message
    // actions is a straight loss. Same reasoning as the selection guard above.
    if ((event.target as HTMLElement | null)?.closest('a, img, video, audio')) {
      return;
    }
    const bar = this.toolbar();
    if (!bar) {
      return; // read-only rows and system events have no actions to offer
    }
    event.preventDefault();
    // Android fires `contextmenu` at the end of a long press, so on a mobile OS this
    // arrives right after the sheet has opened. Swallowing the native menu is still
    // wanted; opening a SECOND menu on top of the sheet is not.
    if (isMobileOs()) {
      return;
    }
    bar.openMoreMenu();
  }

  /**
   * Touch has no right-click, so a long press stands in for it — the same actions, reached
   * the way every other app on the device reaches them.
   */
  onPointerDown(event: PointerEvent): void {
    // Neither gesture belongs to a mouse: the pointer has a hover bar and a right-click.
    if (event.pointerType === 'mouse') {
      return;
    }
    // Only the first finger arms anything. Without this a second pointer overwrote the
    // timer handle while the first timer stayed scheduled: pinch-zooming a message
    // cancelled the one that could be cancelled and let the orphan fire, and the overwrite
    // measured finger one's travel against finger two's origin.
    if (!event.isPrimary) {
      return;
    }

    // The swipe is armed FIRST, and on rows the long press skips, which is why the two
    // guards below sit under it rather than at the top of this method:
    //
    //  - `toolbar()` is absent on decryption failures and redacted rows, and those still
    //    swipe to Reply — the gesture's whole promise is that it always does the most useful
    //    available thing.
    //  - the media/link bail exists because the OS offers its own menu on those elements. A
    //    horizontal drag is not a menu, and media rows are exactly the ones whose swipe
    //    means Reply, so sharing that bail would kill the gesture across most of a timeline.
    if (this.armSwipe(event)) {
      // The shell's drawer arms on this same `pointerdown`, bubbling, on `.chat-body` — and
      // while it is open it arms ANYWHERE, with no edge zone. Stopping propagation is what
      // keeps a thread reply's swipe from also closing the drawer. Only when the gesture
      // actually armed: off, mouse and the dead zone all leave the drawer exactly as it was.
      event.stopPropagation();
    }

    if (!this.toolbar()) {
      return;
    }
    // A long press on a link or an attachment belongs to the BROWSER — "Open in new tab",
    // "Save image". Those live nowhere else, so taking them away to offer message actions
    // is a straight loss. `onContextMenu` has always guarded this; the touch path did not,
    // which meant the same press that raised the OS menu also opened ours behind it.
    //
    // `img` also catches the sender avatar — but only sometimes, which is worth stating
    // precisely: `trn-avatar` renders an `<img>` only once the image has LOADED, and falls
    // back to a `<span>` with the initial otherwise. So a press on the 40px avatar column
    // gets the browser's image menu and no sheet for a sender who has one, and opens the
    // sheet for a sender who does not. Deliberate, because the rule is "whatever the OS
    // offers on this element wins" and a per-element exception list is the thing that rots —
    // but not uniform, and the message body either side of it is a much larger target.
    if ((event.target as HTMLElement | null)?.closest('a, img, video, audio')) {
      return;
    }
    // Any press already pending is cleared before a new one is scheduled.
    this.cancelLongPress();
    this.longPressOrigin = { x: event.clientX, y: event.clientY };
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      if (this.hasTextSelection()) {
        return;
      }
      // On a phone or tablet the actions are a bottom sheet, which is what those
      // platforms do for a long press — and which cannot cover the message it acts on,
      // be dismissed by a stray scroll, or open a picker off the top of the scroller.
      // Everywhere else the hover bar is right, and is left exactly as it was.
      if (isMobileOs()) {
        // The press won; the drag is no longer a candidate. Without this the sheet opens and
        // a continued drag still commits underneath its backdrop.
        this.cancelSwipe();
        this.longPress.emit();
        return;
      }
      this.revealToolbar();
    }, LONG_PRESS_MS);
  }

  /**
   * A press that travels is a scroll, and a timeline is mostly scrolled. Cancelling on
   * movement is what keeps the menu from firing at the end of a flick.
   */
  onPointerMove(event: PointerEvent): void {
    this.trackSwipe(event);
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
  /** A finger lifting ends both gestures — the press without firing, the drag by deciding. */
  onPointerUp(event: PointerEvent): void {
    this.releaseSwipe(event);
    this.cancelLongPress();
  }

  /** The browser took the gesture away (a scroll won, or the pointer was cancelled). */
  onPointerCancel(): void {
    this.cancelSwipe();
    this.cancelLongPress();
  }

  cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.longPressOrigin = null;
  }

  /**
   * Whether a sideways drag is armed on this row, and how far it has travelled.
   *
   * `null` when nothing is armed — which is what the `off` setting produces, rather than a
   * drag that moves and springs back. Off means no listeners do anything and the row never
   * moves.
   */
  private swipeStart: { x: number; y: number; id: number } | null = null;

  /** True once a drag has passed the slop and is definitely this gesture, not a scroll. */
  private swiping = false;

  /**
   * Arm a sideways drag, if every condition holds.
   *
   * Called from `onPointerDown` after the long press has had its look at the event. Returns
   * whether it armed, because the caller uses that to decide about propagation.
   */
  private armSwipe(event: PointerEvent): boolean {
    if (this.swipeDirection() === 'off') {
      return false;
    }
    // Measured at the START, in viewport coordinates, because that is where the competitors
    // live. A drag that begins in the middle and travels INTO an edge is fine: these are
    // edge-start recognisers, so nothing takes it away mid-gesture.
    const width = typeof window === 'undefined' ? 0 : window.innerWidth;
    if (
      event.clientX <= SWIPE_DEAD_ZONE_PX ||
      width - event.clientX <= SWIPE_DEAD_ZONE_PX
    ) {
      return false;
    }
    this.swipeStart = {
      x: event.clientX,
      y: event.clientY,
      id: event.pointerId,
    };
    this.swiping = false;
    // Without capture, a drag that drifts off a one-line continuation row never sees its
    // `pointerup` and leaves the row translated with nothing to put it back. jsdom has no
    // pointer capture at all, hence the optional call.
    (event.target as Element | null)?.setPointerCapture?.(event.pointerId);
    return true;
  }

  /** Track an armed drag, or abandon it if it turns out to be a scroll. */
  private trackSwipe(event: PointerEvent): void {
    const start = this.swipeStart;
    if (!start || event.pointerId !== start.id) {
      return;
    }
    if (Math.abs(event.clientY - start.y) > SWIPE_VERTICAL_SLOP_PX) {
      this.cancelSwipe();
      return;
    }
    const delta = event.clientX - start.x;
    // Travel is only counted in the direction the setting asked for; the other way clamps to
    // zero, so a wrong-way drag reads as no drag rather than as a negative one.
    const travelled =
      this.swipeDirection() === 'left'
        ? Math.max(0, -delta)
        : Math.max(0, delta);
    if (travelled > LONG_PRESS_SLOP_PX) {
      // This is a swipe, so it is not a press. Without this a slow drag — press, pause past
      // 500ms, then move — opens the action sheet AND commits the swipe behind its backdrop.
      this.cancelLongPress();
      this.swiping = true;
    }
    this.paintSwipe(travelled);
  }

  /** Release an armed drag: commit past the threshold, otherwise put the row back. */
  private releaseSwipe(event: PointerEvent): void {
    const start = this.swipeStart;
    if (!start || event.pointerId !== start.id) {
      return;
    }
    const delta = event.clientX - start.x;
    const travelled =
      this.swipeDirection() === 'left'
        ? Math.max(0, -delta)
        : Math.max(0, delta);
    // `.msg`, not the host: `:host { display: contents }` means the component has no box of
    // its own and would measure 0, which reads as "never far enough" and never commits.
    const root = this.host.nativeElement as HTMLElement;
    const width =
      root.querySelector<HTMLElement>('.msg')?.getBoundingClientRect().width ??
      0;
    const committed =
      this.swiping && width > 0 && travelled >= width * SWIPE_COMMIT_FRACTION;
    this.cancelSwipe();
    if (committed) {
      this.swipe.emit();
    }
  }

  /** Disarm, put the row back, and forget the pointer. */
  cancelSwipe(): void {
    this.swipeStart = null;
    this.swiping = false;
    this.paintSwipe(0);
  }

  /**
   * Move the row under the finger.
   *
   * One custom property written straight to the element per `pointermove`, which is what the
   * drawer and the pane handle do and for the same reason: a signal write per move on an
   * OnPush row would run change detection over the whole timeline for a value only CSS reads.
   */
  private paintSwipe(distance: number): void {
    const root = this.host.nativeElement as HTMLElement;
    const msg = root.querySelector<HTMLElement>('.msg');
    if (!msg) {
      return;
    }
    if (distance <= 0) {
      msg.style.removeProperty('--swipe-drag');
      msg.classList.remove('msg--swiping');
      return;
    }
    const signed = this.swipeDirection() === 'left' ? -distance : distance;
    msg.style.setProperty('--swipe-drag', `${Math.round(signed)}px`);
    // Drives both the icon's visibility and the 1:1 follow; the eased spring-back returns
    // when this comes off. A class rather than a signal for the reason `paintSwipe` exists.
    msg.classList.add('msg--swiping');
  }

  /**
   * Pin the action bar open, until the next tap outside this row or the next scroll.
   *
   * Both dismissals are captured at the document, because the thing that should close it is
   * usually not inside this component — and the listeners exist only while a row is actually
   * revealed, so the timeline is not carrying one per row.
   */
  private revealToolbar(): void {
    if (this.revealed()) {
      return;
    }
    this.revealed.set(true);

    const onPointerDown = (event: Event) => {
      if (!this.host.nativeElement.contains(event.target as Node)) {
        this.hideToolbar();
      }
    };
    const onScroll = () => this.hideToolbar();
    // Capture phase, and `scroll` does not bubble — without `true` a scroll inside the
    // timeline's own scroller would never reach a listener on the document.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('scroll', onScroll, true);
    this.dismissReveal = () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }

  /** Unpin the bar and drop the listeners that were watching for a reason to. */
  hideToolbar(): void {
    this.dismissReveal?.();
    this.dismissReveal = null;
    this.revealed.set(false);
  }

  /** An action was chosen, so the bar has done its job. */
  onToolbarAction(event: MessageRowAction): void {
    this.hideToolbar();
    this.action.emit(event);
  }

  /**
   * Whether the user has text selected IN THIS ROW — their selection, their menu.
   *
   * Scoped to the row rather than the document: a selection is a statement about one
   * message, and a document-wide check let text highlighted in one message suppress the
   * context menu on every other row in the timeline until it was cleared.
   */
  private hasTextSelection(): boolean {
    const selection = document.getSelection();
    if (!selection || selection.toString().trim().length === 0) {
      return false;
    }
    const anchor = selection.anchorNode;
    return anchor !== null && this.host.nativeElement.contains(anchor);
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

  /**
   * A long press on a phone or tablet — the host offers this row's actions as a sheet.
   *
   * An output rather than a sheet opened here, and the distinction is the design: this
   * component is destroyed by a redaction, an edit, the local-echo id swap when a send
   * lands, or simply scrolling out of the virtual window. A sheet holding handlers that
   * call back into it would go silent the moment that happened, with every row still
   * tappable and nothing to see. The list owns the sheet; see `onRowLongPress` there.
   */
  readonly longPress = output<void>();

  /**
   * Which way this row is dragged to act on it, already resolved by whoever renders it.
   *
   * Resolved by the caller and not read here, deliberately: the answer depends on the
   * preference, on whether the shell's drawer is open, and on the breakpoint — three things
   * a presentational row has no business knowing. The row is handed a direction and obeys it.
   */
  readonly swipeDirection = input<SwipeDirection>('off');

  /**
   * A committed sideways drag — the host edits this row or replies to it.
   *
   * Payload-free and dispatched by the host for the same reason {@link longPress} is: this
   * component does not survive a redaction, an edit, the local-echo id swap, or scrolling
   * out of the virtual window. What the host does with it is decided from the same `caps`
   * this row drew its icon from, so the affordance and the action cannot disagree.
   */
  readonly swipe = output<void>();

  /** A `matrix.to` permalink clicked in the message body, for the host to route in-app. */
  readonly matrixLink = output<MatrixLinkClick>();

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
