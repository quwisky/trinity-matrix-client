import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
  type Signal,
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
import { TrnButton } from '@trinity/components/controls';
import { type UndecryptableFix } from '../shared/undecryptable-fix.service';
import { TimelineScrollActivity } from '../shared/timeline-scroll-activity';
import { scrollBehavior } from '@trinity/util/ui';
import { ExpandedBodiesStore } from '../rooms/expanded-bodies.store';
import { BodyMeasureDirective, BodyOverflowObserver } from './body-overflow';

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
   * Label for a day separator rendered ABOVE this row ("Today"/"Yesterday"/a date), or absent
   * when the row does not begin a new local calendar day.
   *
   * The finished label rather than a flag or epoch: at midnight "Today" becomes "Yesterday" while
   * those stay identical, so the list's row cache would hit and the OnPush row never re-render.
   * With the label as the cached value, a rollover invalidates the row.
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
  /** Whether a forward can carry this message; see `isForwardableMessage`. */
  canForward: boolean;
  /** Offer "Add to my emoji": a sticker whose image is not in the personal pack yet. */
  addToEmoji?: boolean;
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
  /** Show this message's earlier versions; raised by the "(edited)" marker, which is part of the row, not `MessageAction`. */
  | { type: 'edit-history' }
  /** Show everyone who reacted — raised by the reaction pills' trailing chip. */
  | { type: 'reactors' }
  /** Open the fix Trust offers for a message this device could not decrypt. */
  | { type: 'fix-undecryptable' };

/** How long a press has to be held before it counts as one, in milliseconds. */
const LONG_PRESS_MS = 500;
/** How far the pointer may drift before the press is a scroll instead. Must equal the swipe's slop. */
const LONG_PRESS_SLOP_PX = SWIPE_SLOP_PX;

export { SWIPE_DEAD_ZONE_PX, type SwipeDirection };

/** The semantic action a row resolved from its affordance when a swipe committed. */
export type MessageSwipeAction = 'edit' | 'reply';

/** Ids for each row's body, so its Show more button can name what it controls. */
let nextBodyId = 0;

/**
 * One presentational message row, shared by the main timeline ({@link MessageListComponent}) and
 * the thread view so both render identically: header/continuation, reply preview, body,
 * reactions, hover toolbar and (main timeline only) a thread indicator.
 *
 * Stateless: it raises intent outputs and leaves orchestration to its host. In `readOnly` mode
 * the hover toolbar and retry affordance are suppressed (view-only thread panel).
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
    TrnButton,
    BodyMeasureDirective,
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
  /** The rooms page's Show more state; absent outside the rooms page. */
  private readonly expandedBodies = inject(ExpandedBodiesStore, {
    optional: true,
  });
  /** The list's body measurement; absent outside a timeline or thread list. */
  private readonly bodyOverflow = inject(BodyOverflowObserver, {
    optional: true,
  });
  /** The list's measurement of this row's body, held while the row is rendered. */
  private readonly bodyMeasurement = signal<Signal<boolean> | null>(null);
  /** The list's scroll state; absent where a row renders outside the timeline. */
  private readonly scrollActivity = inject(TimelineScrollActivity, {
    optional: true,
  });
  /** This row's hover work, held back while the list scrolls ({@link onPointerEnter}). */
  private readonly deferredHover = (): void => {
    if (this.pointerInside) {
      this.showHover(this.deferredPointerType);
    }
  };
  private deferredPointerType: string | undefined;

  private readonly toolbar = viewChild(MessageToolbarComponent);
  private readonly swipeGesture = viewChild(MessageSwipeDirective);
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressOrigin: {
    x: number;
    y: number;
    anchor: HTMLElement;
  } | null = null;
  private dismissReveal: (() => void) | null = null;
  /** A plain field, not a signal: it only gates {@link releaseToolbar}, never the template. */
  private pointerInside = false;
  /**
   * Whether the toolbar's quick reactions or overflow menu is open. It keeps the bar mounted
   * ({@link releaseToolbar}) and visible (`.msg--menu-open`) while pointer or focus is elsewhere:
   * WebKit doesn't focus a clicked button, so `:has(:focus)` alone can't.
   *
   * Reset whenever the toolbar mounts or unmounts: a toolbar removed with a menu open never
   * reports it closed, and a stale flag would pin every later bar. Derived rather than an effect,
   * which every row would otherwise create and schedule.
   */
  protected readonly menuOpen = linkedSignal({
    source: this.toolbar,
    computation: () => false,
  });

  /** The clamp wrapper's id, which the Show more button names in `aria-controls`. */
  protected readonly bodyId = `msg-body-${++nextBodyId}`;

  /** Whether the pointer or focus is on this row, which is what mounts its toolbar. */
  readonly toolbarActive = signal(false);
  /** Whether the time's tooltip exists yet; see {@link MessageTimeComponent}. */
  readonly timeTipArmed = signal(false);

  /**
   * Whether this row's action bar is pinned open, which is how touch reaches it.
   *
   * The bar is revealed on hover and touch has none. The long press opens the OVERFLOW menu, which
   * lacks Reply, Add reaction and Reply in thread (the bar's own buttons), so the long press
   * reveals the bar itself. One row at a time, gone on the next tap.
   */
  readonly revealed = signal(false);

  constructor() {
    // The list keeps a row's measurement only while the row holds it, keyed by the id alone, so a
    // row update (a reaction, a receipt) does not let go and take it again.
    const bodyOverflow = this.bodyOverflow;
    if (this.bodyClampable && bodyOverflow) {
      const id = computed(() => this.row().id);
      effect((onCleanup) => {
        const { long, release } = bodyOverflow.hold(id());
        this.bodyMeasurement.set(long);
        onCleanup(release);
      });
    }
    this.destroyRef.onDestroy(() => {
      this.cancelLongPress();
      this.hideToolbar();
      this.scrollActivity?.cancel(this.deferredHover);
    });
  }

  /**
   * Right-click opens the message's own actions instead of the browser's.
   *
   * Not suppressed over a selection: a user with highlighted text is asking for Copy. The native
   * menu is only prevented where this row actually handles the event.
   */
  onContextMenu(event: Event): void {
    if (this.hasTextSelection()) {
      return;
    }
    // A right-click on a link or attachment wants the BROWSER's menu ("Open link in new tab",
    // "Save image as…"), which lives nowhere else. Same reasoning as the selection guard above.
    if ((event.target as HTMLElement | null)?.closest('a, img, video, audio')) {
      return;
    }
    // Android fires `contextmenu` at the end of a long press, right after the sheet opened.
    // Swallowing the native menu is still wanted; opening a SECOND menu over the sheet is not.
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
    // Not mounted yet (context menu with no hover or focus first): mount it, then open the menu.
    this.toolbarActive.set(true);
    afterNextRender(() => this.toolbar()?.openMoreMenu(options), {
      injector: this.injector,
    });
  }

  /** Touch has no right-click, so a long press stands in for it with the same actions. */
  onPointerDown(event: PointerEvent): void {
    // Neither gesture belongs to a mouse: the pointer has a hover bar and a right-click.
    if (event.pointerType === 'mouse') {
      return;
    }
    // Only the first finger arms anything. Otherwise a second pointer overwrote the timer handle
    // while the first timer stayed scheduled (pinch-zoom let the orphan fire) and measured finger
    // one's travel against finger two's origin.
    if (!event.isPrimary) {
      return;
    }

    // The swipe is armed FIRST, and on rows the long press skips, which is why the two guards
    // below sit under it:
    //  - `toolbar()` is absent on decryption failures and redacted rows, and those still swipe to Reply.
    //  - the media/link bail exists because the OS offers its own menu on those elements; a
    //    horizontal drag is not a menu, and media rows are exactly where swipe means Reply.
    if (this.swipeGesture()?.arm(event)) {
      // The shell's drawer arms on this same bubbling `pointerdown` on `.chat-body`, and while open
      // arms ANYWHERE. Stopping propagation keeps a thread reply's swipe from also closing the
      // drawer. Only when the gesture actually armed: off, mouse and the dead zone leave the drawer alone.
      event.stopPropagation();
    }

    if (!this.hasMessageActions()) {
      return;
    }
    // A long press on a link or attachment belongs to the BROWSER ("Open in new tab", "Save image"),
    // which lives nowhere else; otherwise the press that raised the OS menu also opens ours behind it.
    //
    // `img` also catches the sender avatar, but only sometimes: `trn-avatar` renders an `<img>` only
    // once the image has LOADED, else a `<span>` with the initial. So a loaded avatar gets the
    // browser's image menu and no sheet. Deliberate: "whatever the OS offers on this element wins",
    // since a per-element exception list rots.
    if ((event.target as HTMLElement | null)?.closest('a, img, video, audio')) {
      return;
    }
    // `currentTarget` is the concrete `.msg` during dispatch and reset to null afterward, so
    // capture it now rather than in the 500ms timer.
    const anchor =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget
        : (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>(
            '.msg',
          );
    if (!anchor) {
      return;
    }
    // Clear any pending press before scheduling a new one.
    this.cancelLongPress();
    const context = { x: event.clientX, y: event.clientY, anchor };
    this.longPressOrigin = context;
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      if (this.hasTextSelection()) {
        return;
      }
      // On a phone or tablet the actions are a bottom sheet, which cannot cover the message it acts
      // on, be dismissed by a stray scroll, or open a picker off the top of the scroller.
      // Elsewhere the hover bar is right and is left as it was.
      if (this.mobileActions) {
        // The press won; the drag is no longer a candidate, or a continued drag would still commit under the backdrop.
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

  /** A press that travels is a scroll: cancelling on movement keeps the menu from firing at the end of a flick. */
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
   * Pin the action bar open until the next tap outside this row or the next scroll. Both dismissals
   * are captured at the document (the closer is usually outside this component), and the listeners
   * exist only while a row is revealed, not one per row.
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
    // Capture phase: `scroll` does not bubble, so a scroll in the timeline's own scroller would
    // not otherwise reach a document listener.
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
    this.pointerInside = true;
    // A row slid under a still pointer by a scroll is passed, not pointed at: mount nothing until
    // the scroll settles, then only on the row the pointer rests on.
    if (this.scrollActivity?.active) {
      this.deferredPointerType = event?.pointerType;
      this.scrollActivity.defer(this.deferredHover);
      return;
    }
    this.showHover(event?.pointerType);
  }

  private showHover(pointerType: string | undefined): void {
    this.armTimeTip(pointerType);
    this.toolbarActive.set(true);
    this.toolbar()?.placeToolbar();
  }

  /**
   * Create the time's tooltip when a mouse or pen first reaches the row. A tooltip registers window
   * listeners and a focus monitor, too much to pay for every row a scroll builds. Touch never opens
   * one and the `<time>` is not focusable, so nothing else needs it earlier.
   */
  private armTimeTip(pointerType: string | undefined): void {
    if (pointerType === 'mouse' || pointerType === 'pen') {
      this.timeTipArmed.set(true);
    }
  }

  onPointerLeave(): void {
    this.cancelLongPress();
    this.pointerInside = false;
    this.scrollActivity?.cancel(this.deferredHover);
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
    this.menuOpen.set(open);
    if (!open) {
      // Closing may hand focus back to the "⋯" trigger in the same turn; decide after it has.
      queueMicrotask(() => this.releaseToolbar(document.activeElement));
    }
  }

  /**
   * Unmount the toolbar unless something still needs it: the pointer, keyboard focus in the row
   * (`focus` is where focus is going or sits), or its overflow menu, which lives in an overlay
   * outside the row and would close under the user. `revealed()` keeps it mounted on its own.
   */
  private releaseToolbar(focus: EventTarget | null): void {
    if (
      this.pointerInside ||
      this.menuOpen() ||
      // Only keyboard focus pins the bar: a click also focuses the row, and must not keep the bar
      // there while the pointer is over another row.
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
   * Whether the user has text selected IN THIS ROW. Scoped to the row, not the document: a
   * document-wide check let text highlighted in one message suppress the context menu on every
   * other row until cleared.
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
    canForward: false,
    readOnly: false,
  });

  /** The fix Trust offers for an unreadable message on this device; null when none applies. */
  readonly undecryptableFix = input<UndecryptableFix | null>(null);

  /** The unreadable-message button's label, or null when this row offers none. */
  readonly undecryptableFixLabel = computed(() => {
    const fix = this.undecryptableFix();
    return fix &&
      this.row().undecryptable?.deviceFixable &&
      !this.caps().readOnly
      ? fix.label
      : null;
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
   * A long press on a phone or tablet; the host offers this row's actions as a sheet.
   *
   * An output rather than a sheet opened here, by design: this component is destroyed by a
   * redaction, an edit, the local-echo id swap when a send lands, or scrolling out of the virtual
   * window, and a sheet calling back into it would go silent. The list owns the sheet
   * (`onRowLongPress`).
   */
  readonly longPress = output<MessageLongPressContext>();

  /**
   * Which way this row is dragged to act on it, resolved by the caller: the answer depends on the
   * preference, whether the shell's drawer is open and the breakpoint, which a presentational row
   * should not know.
   */
  readonly swipeDirection = input<SwipeDirection>('off');

  /**
   * A committed sideways drag; the host edits or replies to this row.
   *
   * The action is captured from the affordance at commit time, before gesture cleanup. The host
   * must not re-read live capabilities: the row may have left its window or caps map, and the
   * action must stay the one the reader saw on release.
   */
  readonly swipe = output<MessageSwipeAction>();

  /**
   * What a committed swipe would do to this row: the affordance and the action in one value.
   * Bound to both the icon name and `data-swipe-action`, so the two cannot disagree.
   */
  readonly swipeAction = computed<MessageSwipeAction>(() =>
    this.caps().editable ? 'edit' : 'reply',
  );

  /**
   * The glyph for that action, derived from it rather than re-deciding it. Two expressions sharing
   * an input are not one expression: swapping the icon names would leave tests green, since they
   * read the attribute and `TrnIconName` only checks a name is registered.
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
   * `edited` alone isn't enough: it comes from the SDK's replacing event, which survives a
   * server-side redaction (only a locally-applied one clears it), so a deleted message could claim
   * to be edited. An undecryptable message is excluded too: its versions can't be shown.
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
      canForward: c.canForward,
      addToEmoji: c.addToEmoji,
    };
  });

  /** Whether the row shows a text body or caption (media without a caption has none). */
  readonly hasTextBody = computed(() => {
    const r = this.row();
    return !r.media || !!r.captionHtml || !!r.caption;
  });

  /** The formatted body or caption, when there is one. */
  readonly bodyHtml = computed(() => {
    const r = this.row();
    return r.media ? r.captionHtml : r.html;
  });

  /** The plain body or caption. */
  readonly bodyText = computed(() => {
    const r = this.row();
    return r.media ? (r.caption ?? '') : r.body;
  });

  /** Long bodies collapse only on rows a list measures and whose state the rooms page keeps: the timeline and thread view. */
  readonly bodyClampable = !!this.expandedBodies && !!this.bodyOverflow;

  /** Whether the body is taller than 24 lines, as the list last measured it. */
  readonly bodyLong = computed(() => this.bodyMeasurement()?.() ?? false);

  readonly bodyExpanded = computed(
    () => this.expandedBodies?.expanded().has(this.row().id) ?? false,
  );

  readonly bodyCollapsed = computed(
    () => this.bodyLong() && !this.bodyExpanded(),
  );

  /**
   * Show more / Show less. The button stays the same element, so focus stays on it. Collapsing a
   * body taller than the screen can leave its row's top above the list; bring it back.
   */
  toggleBody(): void {
    const store = this.expandedBodies;
    if (!store) {
      return;
    }
    const id = this.row().id;
    const collapsing = store.isExpanded(id);
    store.toggle(id);
    if (collapsing) {
      afterNextRender(() => this.revealRowTop(), { injector: this.injector });
    }
  }

  /**
   * Keyboard focus moving into a collapsed body (Tab to a link, mention, image or spoiler past the
   * cut) shows it whole, so the focused control is never hidden behind the fade. Keyboard only
   * (`:focus-visible`): a mouse press focuses links too, and expanding then would move the content
   * (the list re-pins to the bottom) before the button is released, so the click would miss. The
   * list brings the focused control into view after correcting its scroll for the taller row
   * (`MessageListComponent.revealFocusIn`, `ThreadViewComponent.revealFocusAfterExpand`).
   */
  expandBodyForFocus(event: FocusEvent): void {
    const target = event.target;
    if (
      this.bodyCollapsed() &&
      target instanceof Element &&
      target.matches(':focus-visible')
    ) {
      this.expandedBodies?.expand(this.row().id);
    }
  }

  /** If the row's top is above its scroller, scroll the row back into view. */
  private revealRowTop(): void {
    const message = (
      this.host.nativeElement as HTMLElement
    ).querySelector<HTMLElement>('.msg');
    const scroller = message?.closest('[data-message-scroller]');
    if (
      message &&
      scroller &&
      message.getBoundingClientRect().top < scroller.getBoundingClientRect().top
    ) {
      message.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
    }
  }

  /** Whether a shield is drawn in the red warning tone; the not-encrypted mark for a pre-encryption message is as quiet as the grey caution. */
  shieldIsRed(level: MessageShield['level']): boolean {
    return level === 'red' || level === 'unencrypted';
  }

  /**
   * Icon shape per authenticity-shield severity: a distinct glyph per tone so warning (red) and
   * caution (grey) differ by shape, not colour alone. The quiet not-encrypted mark has its own
   * open-lock glyph so it never reads as an unverified device's grey caution.
   */
  shieldIcon(level: MessageShield['level']): TrnIconName {
    if (level === 'unencrypted-history') return 'lock-open';
    return this.shieldIsRed(level) ? 'shield-alert' : 'shield-question';
  }
}
