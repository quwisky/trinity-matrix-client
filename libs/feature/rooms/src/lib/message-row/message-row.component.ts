import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DateTimeFormatService, isMobileOs } from '@trinity/platform-native';
import { AvatarComponent } from '@trinity/components/generic-content';
import { MatrixHtmlDirective } from '../message-presentation/matrix-html.directive';
import {
  MessageSwipeDirective,
  SWIPE_DEAD_ZONE_PX,
  SWIPE_SLOP_PX,
  type SwipeDirection,
} from './message-swipe.directive';
import {
  MessageToolbarComponent,
  type MessageAction,
  type MessageToolbarCaps,
} from '../message-toolbar/message-toolbar.component';
import { TrnTooltip } from '@trinity/components/generic-content';
import {
  type MessageShield,
  type MessageView,
  type ThreadSummary,
} from '@trinity/data-access/timeline';
import { MessageReactionsComponent } from '../message-reactions/message-reactions.component';
import { MediaAttachmentComponent } from '../media-attachment/media-attachment.component';
import { type MatrixLinkClick } from '../matrix-link/matrix-link.directive';
import { PollComponent } from '../poll/poll.component';
import { LinkPreviewComponent } from '../link-preview/link-preview.component';
import { LocationComponent } from '../location-share/location.component';
import { VoiceMessageComponent } from '../voice-message/voice-message.component';
import {
  TrnIconComponent,
  type TrnIconName,
} from '@trinity/components/foundations';
import { MessageReplyPreviewComponent } from '../message-reply-preview/message-reply-preview.component';
import { MessageReceiptsComponent } from '../message-receipts/message-receipts.component';
import { MessageTimeComponent } from '../message-time/message-time.component';
import { MessageThreadSummaryComponent } from '../message-thread-summary/message-thread-summary.component';

/** A collapsed run of adjacent system lines (see `groupSystemRuns`). */
export interface SystemRun {
  readonly events: readonly MessageRow[];
  readonly summary: string;
}

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
  /** Present when this row stands for a run of adjacent system lines. */
  readonly systemRun?: SystemRun;
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
  /** Which kind of media this message can be saved as; null when it has none. */
  saveMedia: 'image' | 'video' | null;
  /** Hide the hover toolbar + retry affordance (view-only thread panel). */
  readOnly: boolean;
}

/** The concrete message and press point a mobile action sheet must preserve. */
export interface MessageLongPressContext {
  /** The real `.msg` box; the component host is `display: contents` and has no geometry. */
  anchor: HTMLElement;
  /** Viewport-space Y coordinate of the finger that won the long press. */
  clientY: number;
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
/** How far the pointer may drift before the press is a scroll instead. Must equal the swipe's slop. */
const LONG_PRESS_SLOP_PX = SWIPE_SLOP_PX;

export { SWIPE_DEAD_ZONE_PX, type SwipeDirection };

/** The semantic action a row resolved from its affordance when a swipe committed. */
export type MessageSwipeAction = 'edit' | 'reply';

/**
 * One presentational message row, shared by the main timeline ({@link
 * MessageListComponent}) and the thread
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
    MatrixHtmlDirective,
    AvatarComponent,
    TrnIconComponent,
    MediaAttachmentComponent,
    MessageReactionsComponent,
    MessageToolbarComponent,
    PollComponent,
    LinkPreviewComponent,
    LocationComponent,
    VoiceMessageComponent,
    TrnTooltip,
    MessageReplyPreviewComponent,
    MessageThreadSummaryComponent,
    MessageReceiptsComponent,
    MessageTimeComponent,
    MessageSwipeDirective,
  ],
  templateUrl: './message-row.component.html',
  styleUrl: './message-row.component.scss',
})
export class MessageRowComponent {
  /** Timestamps go through the app-wide format preference, never a DatePipe. */
  readonly fmt = inject(DateTimeFormatService);

  /** Phones and tablets use the action sheet and do not render the desktop toolbar. */
  readonly mobileActions = isMobileOs();
  private readonly destroyRef = inject(DestroyRef);

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly injector = inject(Injector);

  private readonly toolbar = viewChild(MessageToolbarComponent);
  private readonly swipeGesture = viewChild(MessageSwipeDirective);
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressOrigin: {
    x: number;
    y: number;
    anchor: HTMLElement;
  } | null = null;
  private dismissReveal: (() => void) | null = null;
  /** Plain fields, not signals: they only gate {@link releaseToolbar}, never the template. */
  private pointerInside = false;
  private menuOpen = false;

  /** Whether the pointer or focus is on this row, which is what mounts its toolbar. */
  readonly toolbarActive = signal(false);
  /** Whether the time's tooltip exists yet; see {@link MessageTimeComponent}. */
  readonly timeTipArmed = signal(false);

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
  onContextMenu(event: Event): void {
    if (this.hasTextSelection()) {
      return;
    }
    // A right-click on a link or an attachment wants the BROWSER's menu — "Open link in new
    // tab", "Save image as…". Those live nowhere else, so taking them away to offer message
    // actions is a straight loss. Same reasoning as the selection guard above.
    if ((event.target as HTMLElement | null)?.closest('a, img, video, audio')) {
      return;
    }
    // Android fires `contextmenu` at the end of a long press, so on a mobile OS this
    // arrives right after the sheet has opened. Swallowing the native menu is still
    // wanted; opening a SECOND menu on top of the sheet is not.
    if (this.mobileActions) {
      if (!this.hasMessageActions()) {
        return;
      }
      event.preventDefault();
      return;
    }
    if (!this.hasToolbar()) {
      return; // read-only rows and system events have no actions to offer
    }
    event.preventDefault();
    // Shift+F10 or the context-menu key: focus goes into the menu so arrows and Escape work.
    const options = { focusFirstItem: event instanceof KeyboardEvent };
    const bar = this.toolbar();
    if (bar) {
      bar.openMoreMenu(options);
      return;
    }
    // Not mounted yet (a context menu with no hover or focus first): mount it, then open
    // the menu once it exists.
    this.toolbarActive.set(true);
    afterNextRender(() => this.toolbar()?.openMoreMenu(options), {
      injector: this.injector,
    });
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
    if (this.swipeGesture()?.arm(event)) {
      // The shell's drawer arms on this same `pointerdown`, bubbling, on `.chat-body` — and
      // while it is open it arms ANYWHERE, with no edge zone. Stopping propagation is what
      // keeps a thread reply's swipe from also closing the drawer. Only when the gesture
      // actually armed: off, mouse and the dead zone all leave the drawer exactly as it was.
      event.stopPropagation();
    }

    if (!this.hasMessageActions()) {
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
    // `currentTarget` is the concrete `.msg` while the event is being dispatched. It is
    // reset to null afterward, so capture it now rather than reading it in the 500ms timer.
    const anchor =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget
        : (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>(
            '.msg',
          );
    if (!anchor) {
      return;
    }
    // Any press already pending is cleared before a new one is scheduled.
    this.cancelLongPress();
    const context = { x: event.clientX, y: event.clientY, anchor };
    this.longPressOrigin = context;
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      if (this.hasTextSelection()) {
        return;
      }
      // On a phone or tablet the actions are a bottom sheet, which is what those
      // platforms do for a long press — and which cannot cover the message it acts on,
      // be dismissed by a stray scroll, or open a picker off the top of the scroller.
      // Everywhere else the hover bar is right, and is left exactly as it was.
      if (this.mobileActions) {
        // The press won; the drag is no longer a candidate. Without this the sheet opens and
        // a continued drag still commits underneath its backdrop.
        this.swipeGesture()?.cancel();
        this.longPress.emit({ anchor: context.anchor, clientY: context.y });
        return;
      }
      this.revealToolbar();
    }, LONG_PRESS_MS);
  }

  /** Whether this row has the actions represented by the desktop bar or mobile sheet. */
  private hasMessageActions(): boolean {
    const row = this.row();
    return (
      !this.caps().readOnly && !row.decryptionFailed && row.kind !== 'redacted'
    );
  }

  /**
   * A press that travels is a scroll, and a timeline is mostly scrolled. Cancelling on
   * movement is what keeps the menu from firing at the end of a flick.
   */
  onPointerMove(event: PointerEvent): void {
    this.swipeGesture()?.track(event);
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

  /** A finger lifting ends both gestures — the press without firing, the drag by deciding. */
  onPointerUp(event: PointerEvent): void {
    this.swipeGesture()?.release(event);
    this.cancelLongPress();
  }

  /** The browser took the gesture away (a scroll won, or the pointer was cancelled). */
  onPointerCancel(): void {
    this.swipeGesture()?.cancel();
    this.cancelLongPress();
  }

  /** Lifting, cancelling, or leaving all end the press without opening anything. */
  cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.longPressOrigin = null;
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

  /**
   * Mount the toolbar on hover. A toolbar that already exists is re-placed against the live
   * scrollport; a new one places itself after its first render.
   */
  onPointerEnter(event?: PointerEvent): void {
    this.armTimeTip(event);
    this.pointerInside = true;
    this.toolbarActive.set(true);
    this.toolbar()?.placeToolbar();
  }

  /**
   * Create the time's tooltip when a mouse or pen first reaches the row. A tooltip registers
   * window listeners and a focus monitor, which is a lot to pay for every row a scroll builds.
   * Touch never opens one, and the `<time>` is not focusable, so nothing else needs it earlier.
   */
  private armTimeTip(event: PointerEvent | undefined): void {
    if (event?.pointerType === 'mouse' || event?.pointerType === 'pen') {
      this.timeTipArmed.set(true);
    }
  }

  onPointerLeave(): void {
    this.cancelLongPress();
    this.pointerInside = false;
    this.releaseToolbar(document.activeElement);
  }

  onFocusIn(event: FocusEvent): void {
    if (
      event.target instanceof Element &&
      event.target.matches(':focus-visible')
    ) {
      this.toolbarActive.set(true);
    }
  }

  onFocusOut(event: FocusEvent): void {
    this.releaseToolbar(event.relatedTarget);
  }

  onMenuOpenChange(open: boolean): void {
    this.menuOpen = open;
    if (!open) {
      // Closing may hand focus back to the "⋯" trigger in the same turn; decide after it has.
      queueMicrotask(() => this.releaseToolbar(document.activeElement));
    }
  }

  /**
   * Unmount the toolbar unless something still needs it: the pointer, keyboard focus inside
   * the row (`focus` is where focus is going or now sits), or its overflow menu, which lives in
   * an overlay outside the row and would close under the user. `revealed()` keeps it mounted
   * through the template on its own.
   */
  private releaseToolbar(focus: EventTarget | null): void {
    if (
      this.pointerInside ||
      this.menuOpen ||
      // Only keyboard focus pins the bar: a click also focuses the row, and that must not
      // keep it there while the pointer is over another row (#986 K6).
      (focus instanceof Element &&
        this.host.nativeElement.contains(focus) &&
        focus.matches(':focus-visible'))
    ) {
      return;
    }
    this.toolbarActive.set(false);
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
  readonly threadContinues = input(false);
  /** Per-row capabilities/state (edit/delete/pin permissions, pinned, read-only). */
  readonly caps = input<MessageRowCaps>({
    editable: false,
    deletable: false,
    canPin: false,
    pinned: false,
    canThread: true,
    canQuote: false,
    saveMedia: null,
    readOnly: false,
  });

  /**
   * A user intent raised from this row — a toolbar action, a reaction, a retry, or a
   * jump-to-quoted-message. The host pairs it with `row` to run the effect.
   */
  readonly action = output<MessageRowAction>();
  /** Whether this system-run row is expanded (owned by the list). */
  readonly runExpanded = input(false);
  /** Ask the list to expand or collapse this system-run row. */
  readonly toggleRun = output<void>();

  /**
   * A long press on a phone or tablet — the host offers this row's actions as a sheet.
   *
   * An output rather than a sheet opened here, and the distinction is the design: this
   * component is destroyed by a redaction, an edit, the local-echo id swap when a send
   * lands, or simply scrolling out of the virtual window. A sheet holding handlers that
   * call back into it would go silent the moment that happened, with every row still
   * tappable and nothing to see. The list owns the sheet; see `onRowLongPress` there.
   */
  readonly longPress = output<MessageLongPressContext>();

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
   * The semantic action is captured from the affordance at commit time, before gesture
   * cleanup, then dispatched by the host against its row snapshot. The host must not
   * re-read live capabilities: the row may already have left its virtual window or caps
   * map, and the action must remain the one the reader saw when they released.
   */
  readonly swipe = output<MessageSwipeAction>();

  /**
   * What a committed swipe would do to this row — the affordance and the action in one value.
   *
   * Bound to both the icon's name and the row's `data-swipe-action`, so a test that reads
   * either is reading the same expression. Two parallel ternaries in the template would have
   * been two things that could disagree, which is the defect this whole gesture is designed
   * around.
   */
  readonly swipeAction = computed<MessageSwipeAction>(() =>
    this.caps().editable ? 'edit' : 'reply',
  );

  /**
   * The glyph for that action, derived from it rather than re-deciding it.
   *
   * The template used to bind `swipeAction() === 'edit' ? 'pencil' : 'reply'` beside
   * `[attr.data-swipe-action]="swipeAction()"` — two expressions sharing an input, which is
   * not the same as one expression. Swapping the two icon names left every test green,
   * because the tests read the attribute and `TrnIconName` only type-checks that a name is
   * registered, not that it is the right one.
   */
  readonly swipeIcon = computed<TrnIconName>(() =>
    this.swipeAction() === 'edit' ? 'pencil' : 'reply',
  );

  /** A `matrix.to` permalink clicked in the message body, for the host to route in-app. */
  readonly matrixLink = output<MatrixLinkClick>();

  /** A vote cast on this row's poll (the host sends the m.poll.response). */
  readonly pollVote = output<{
    pollId: string;
    answerIds: readonly string[];
  }>();
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

  /** Whether this row offers the desktop toolbar at all; it is then also a tab stop. */
  readonly hasToolbar = computed(
    () => !this.mobileActions && this.hasMessageActions(),
  );

  /** The focusable row's accessible name: who, when, and the start of what was said. */
  readonly rowLabel = computed(() => {
    const r = this.row();
    const text = (r.body ?? '').trim().replace(/\s+/g, ' ');
    const excerpt = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    const head = `${r.senderName}, ${this.fmt.dateTime(r.timestamp)}`;
    return excerpt ? `${head}: ${excerpt}` : head;
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
      saveMedia: c.saveMedia,
    };
  });

  /** Whether a shield is drawn in the red warning tone. The not-encrypted mark for a
   * message dated before encryption was turned on is as quiet as the grey caution. */
  shieldIsRed(level: MessageShield['level']): boolean {
    return level === 'red' || level === 'unencrypted';
  }

  /** Icon shape for an authenticity shield's severity: a distinct glyph per tone so the
   * warning (red) and caution (grey) are distinguishable by shape, not colour alone. The
   * quiet not-encrypted mark has its own open-lock glyph, so it never reads as the grey
   * caution of an unverified device. */
  shieldIcon(level: MessageShield['level']): TrnIconName {
    if (level === 'unencrypted-history') return 'lock-open';
    return this.shieldIsRed(level) ? 'shield-alert' : 'shield-question';
  }
}
