import {
  DestroyRef,
  Directive,
  afterNextRender,
  ElementRef,
  computed,
  effect,
  Injector,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  TrnAlertService,
  TrnSurfaceService,
} from '@trinity/components/overlay';
import { MessageActionSheetService } from '../message-actions/message-action-sheet.service';
import { type MatrixLinkClick } from '../matrix-link/matrix-link.directive';
import { ForwardService } from '../forward/forward.service';
import { MediaSaveService } from '../media-attachment/media-save.service';
import { AddToMyEmojiService } from '../shared/add-to-my-emoji.service';
import { ReportService } from '../report/report.service';
import { EditHistoryDialogService } from '../edit-history/edit-history.service';
import { ReactionsDialogService } from '../reactions-dialog/reactions-dialog.service';
import {
  isEditableMessage,
  ConversationRuntime,
  type MessageView,
  type ThreadSummary,
  type TimelineLoadState,
  READY_LOAD_STATE,
} from '@trinity/data-access/timeline';
import { quoteBlock, type Mention } from '@trinity/util/matrix';
import { HapticsService } from '@trinity/platform-native';
import { MessageRowModel } from './message-row-model';
import { TrnFileDropDirective } from '../shared/file-drop.directive';
import { delayedBusy } from '@trinity/util/ui';
import {
  type BatchItem,
  type BatchOutcome,
  type BatchProgress,
} from '../shared/send-media-batch';
import {
  buildRowCapsMap,
  addableImages,
  dispatchSharedRowAction,
} from '../shared/row-actions';
import {
  type MessageLongPressContext,
  type MessageRow,
  type MessageRowAction,
  type MessageRowCaps,
  type MessageSwipeAction,
  type SwipeDirection,
} from '../message-row/message-row.component';
import {
  MessageComposerComponent,
  type ComposerSubmit,
  type MentionMember,
} from '../message-composer/message-composer.component';
import type { ImagePack, ImagePackImage } from '@trinity/data-access/media';
import { observeScrollerHeight } from './scroller-height-anchor';
import { confirmMessageDeletion$ } from '../message-actions/confirm-message-deletion';
import { ExpandedBodiesStore } from '../rooms/expanded-bodies.store';
import {
  UndecryptableFixService,
  type UndecryptableFix,
} from '../shared/undecryptable-fix.service';

/** How {@link MessageListBase.jumpTo} reaches a row already in the DOM. */
export interface JumpOptions {
  /** Scroll after the next render: the caller has just grown the row. */
  readonly afterRender?: boolean;
}

/** How long after a jump a width change still counts as "the same jump" (panel close, pane drag). */
const JUMP_REAPPLY_MS = 3_000;

/** Fallback caps for a row missing from the memoized map (defensive). */
const DEFAULT_ROW_CAPS: MessageRowCaps = {
  editable: false,
  deletable: false,
  canPin: false,
  pinned: false,
  canThread: true,
  canQuote: false,
  canRespond: true,
  saveMedia: null,
  canForward: false,
  readOnly: false,
};

const LOAD_ERROR_COPY: Readonly<
  Record<Extract<TimelineLoadState, { kind: 'error' }>['reason'], string>
> = {
  'room-unavailable': "This room isn't available on this account yet.",
  'sync-stopped': "Can't reach your server.",
  'backfill-failed': "Couldn't load messages.",
};

/**
 * Scroll-strategy-independent domain logic for the room timeline: inputs/outputs, edit/reply
 * state and the Discord-style row grouping. Abstract `@Directive()` so it is testable without
 * the scroll half in {@link MessageListComponent}.
 */
@Directive()
export abstract class MessageListBase {
  readonly messages = input<readonly MessageView[]>([]);
  /** Thread summaries keyed by root event id, for the per-row thread indicator. */
  readonly threadSummaries = input<Record<string, ThreadSummary>>({});
  /** Whether the current user may pin/unpin in this room (drives the per-row Pin item). */
  readonly canPin = input(false);
  /** Whether the current user may redact OTHER people's messages here (a moderator). */
  readonly canRedactOthers = input(false);
  /** Set while the user may not post here; the composer shows it in place of its controls. */
  readonly postUnavailableReason = input<string | null>(null);
  /** Currently-pinned event ids, for the per-row pinned state. */
  readonly pinnedIds = input<readonly string[]>([]);
  readonly loadingOlder = input(false);
  /**
   * Gates only the appearance of the "Loading older messages…" strip.
   *
   * `minimumMs: 0` is load-bearing: a minimum hold would leave `delayedBusy` "visible" after a
   * slow page, so the next fast backfill would skip the delay and flash the strip. Zero ends the
   * hold with the load, so every backfill is judged on its own duration.
   *
   * The strip must vanish synchronously with the prepend (the AND in {@link showLoadingOlder}
   * does that): it is in flow above the rows and `rowsRegionTop()` folds its height into the
   * scroll restore, and `.scroll` sets `overflow-anchor: none`, so a strip held past the prepend
   * would make the content jump up by its height. This relies on `TimelineService.loadOlder`
   * prepending the rows and clearing `loadingOlder` in one synchronous block.
   */
  private readonly loadingOlderSettled = delayedBusy(
    this.loadingOlder,
    inject(Injector),
    { minimumMs: 0 },
  );

  /**
   * `loadingOlder`, delayed so a fast backfill shows no strip at all.
   *
   * The raw input is ANDed in so removal stays synchronous with the prepend; the delayed signal
   * only decides whether the strip was ever worth showing. A load landing just past the delay
   * shows it briefly, which is rarer than the flicker and the only alternative moves content.
   */
  protected readonly showLoadingOlder = computed(
    () => this.loadingOlder() && this.loadingOlderSettled(),
  );

  /** The conversation's loading interval. Not an empty list: an empty room is `empty`. */
  readonly loadState = input<TimelineLoadState>(READY_LOAD_STATE);
  readonly retryLoad = output<void>();

  protected readonly loadingConversation = computed(
    () => this.loadState().kind === 'loading',
  );
  private readonly loadingConversationSettled = delayedBusy(
    this.loadingConversation,
    inject(Injector),
    { minimumMs: 0 },
  );
  /** Skeleton after 150 ms of real loading; gone the instant loading ends. */
  protected readonly showSkeleton = computed(
    () => this.loadingConversation() && this.loadingConversationSettled(),
  );
  /** Ready or empty: the only states that may say "No messages yet." or page by themselves. */
  protected readonly settled = computed(() => {
    const kind = this.loadState().kind;
    return kind === 'ready' || kind === 'empty';
  });
  protected readonly sendBlocked = computed(() => !this.settled());
  protected readonly loadError = computed(() => {
    const state = this.loadState();
    return state.kind === 'error' ? LOAD_ERROR_COPY[state.reason] : null;
  });
  readonly canLoadOlder = input(false);
  /** Oldest RAW event in the loaded window (the backfill marker), not the oldest rendered row. */
  readonly oldestEventId = input<string | null>(null);
  readonly roomName = input('');
  /** False while the Room is not held by the client: there is nothing to send to yet. */
  readonly composerEnabled = input(true);
  /**
   * Active room id. The list instance is reused across room switches, so a change resets
   * per-room UI and scroll state ({@link resetOnRoomChange}); otherwise edit/reply targets and
   * scroll anchors leak between rooms.
   */
  readonly roomId = input<string | null>(null);
  readonly accountId = input<string | null>(null);
  /** Room members, forwarded to the composer's @-mention autocomplete. */
  readonly members = input<readonly MentionMember[]>([]);
  /** Display names of members currently typing in the room (excludes the local user). */
  readonly typingNames = input<string[]>([]);
  /** Event id of the first unread message: the "New messages" divider and jump pill key off it. */
  readonly firstUnreadId = input<string | null>(null);
  /** Which file of how many is uploading and how far along, or null when idle. */
  readonly uploadProgress = input<BatchProgress | null>(null);
  readonly stickerPacks = input<readonly ImagePack[]>([]);
  /** Event id to scroll into view (external jump, e.g. in-room search); waits briefly for it to load. */
  readonly jumpToId = input<string | null>(null);
  /**
   * Bumped on every jump request so re-requesting the SAME event id still changes an input;
   * an unchanged `jumpToId` alone would be an Object.is no-op.
   */
  readonly jumpToNonce = input(0);
  readonly loadOlder = output<void>();
  /** Open the thread rooted at this event id (raised by a row's indicator). */
  readonly openThread = output<string>();
  /** Pin or unpin this event id (host resolves which, given its current pinned state). */
  readonly togglePin = output<string>();
  readonly send = output<{ body: string; mentions: Mention[] }>();
  readonly sendSticker = output<ImagePackImage>();
  /**
   * Send a batch of staged attachments. The sender MUST call `onOutcomes`: it lets the composer
   * keep failed items staged and also releases the one-at-a-time send latch.
   */
  readonly sendMedia = output<{
    items: readonly BatchItem[];
    caption: string;
    onOutcomes: (outcomes: readonly BatchOutcome[]) => void;
  }>();
  readonly retry = output<string>();
  readonly cancelSend = output<string>();
  readonly deleteMessage = output<string>();
  readonly react = output<{ id: string; key: string }>();
  /** A `matrix.to` permalink clicked in a message body, for the host to route in-app. */
  readonly matrixLink = output<MatrixLinkClick>();
  /** A vote cast on a poll (the host sends the response). */
  readonly pollVote = output<{
    pollId: string;
    answerIds: readonly string[];
  }>();
  /** A request to close a poll (the host sends the end event). */
  readonly pollEnd = output<string>();

  protected readonly compose = inject(ConversationRuntime).compose;
  protected readonly messageCommands = inject(ConversationRuntime).messages;
  private readonly timeline = inject(ConversationRuntime).timeline;
  readonly editingId = computed(() => {
    const intent = this.compose.intent();
    return intent.kind === 'edit' ? intent.eventId : null;
  });
  readonly editingDraft = computed(
    () => this.messages().find((m) => m.id === this.editingId())?.body ?? '',
  );

  readonly replyingToId = computed(() => {
    const intent = this.compose.intent();
    return intent.kind === 'reply' ? intent.eventId : null;
  });
  readonly replyingToName = computed(
    () =>
      this.messages().find((m) => m.id === this.replyingToId())?.senderName ??
      '',
  );

  /** Live-region text announcing a newly-arrived incoming message to screen readers. */
  readonly announcement = signal('');

  /** True while unread exist and the "New messages" divider is outside the viewport. */
  readonly showJumpToUnread = signal(false);

  /** Files dragged onto the conversation; the drop directive is a host directive on both lists. */
  protected readonly fileDrop = inject(TrnFileDropDirective);
  protected readonly alert = inject(TrnAlertService);
  private readonly dialog = inject(TrnSurfaceService);
  private readonly forwardSvc = inject(ForwardService);
  private readonly reportSvc = inject(ReportService);
  private readonly mediaSave = inject(MediaSaveService);
  private readonly addToEmoji = inject(AddToMyEmojiService);
  private readonly editHistorySvc = inject(EditHistoryDialogService);
  private readonly reactionsDialog = inject(ReactionsDialogService);
  private readonly messageSheet = inject(MessageActionSheetService);
  private readonly haptics = inject(HapticsService);

  /**
   * Which way a row is dragged to act on it, resolved by the page (it depends on the drawer,
   * which neither list nor row can see). `'off'` means the gesture does not arm at all.
   */
  readonly swipeDirection = input<SwipeDirection>('off');
  protected readonly scrollEl = viewChild<ElementRef<HTMLElement>>('scroll');

  /** The composer rendered by each concrete list: quotes and dropped files go straight into it. */
  private readonly composer = viewChild(MessageComposerComponent);

  /**
   * Stage files dropped on the conversation. Goes through the composer because the attachments
   * service is provided BY the composer, so it does not exist at this level.
   */
  protected onFilesDropped(files: readonly File[]): void {
    this.composer()?.stageFiles(files);
  }

  /** Row grouping and its caches; declared after the inputs it reads. */
  private readonly rowModel = new MessageRowModel(
    this.messages,
    this.firstUnreadId,
    this.threadSummaries,
  );

  /** The grouped rows the list renders. */
  readonly rows = this.rowModel.rows;

  /** Member event id → the id of the group row that holds it. */
  readonly runOf = this.rowModel.runOf;

  /** Group rows the reader has expanded; in memory only, cleared on a room switch. */
  readonly expandedRuns = this.rowModel.expandedRuns;

  toggleRun(groupId: string): void {
    this.rowModel.toggleRun(groupId);
  }

  /** The row to scroll to for an event: itself, or its group expanded so the line is on screen. */
  revealEvent(eventId: string): string {
    return this.rowModel.revealEvent(eventId);
  }

  /** The row the "New messages" divider sits above (a run splits at the first unread). */
  readonly unreadRowId = this.rowModel.unreadRowId;

  /** Rows whose avatar column continues to a later thread in the same sender group. */
  readonly threadContinuationIds = this.rowModel.threadContinuationIds;

  /** The rooms page's Show more state; absent where no rooms page provides it. */
  private readonly expandedBodies = inject(ExpandedBodiesStore, {
    optional: true,
  });

  /**
   * Declared ABOVE the constructor on purpose: the constructor registers an `onDestroy` on it,
   * which works wherever the field sits (every initializer runs before the constructor body), but
   * TS2729 would not catch it drifting below a subclass.
   */
  private readonly listDestroyRef = inject(DestroyRef);
  protected readonly injector = inject(Injector);

  /** A requested jump whose row had not loaded yet; applied on arrival, within the limit. */
  private awaitedJumpId: string | null = null;
  private awaitedJumpAt = 0;

  constructor() {
    // A host directive's outputs are not template-bound, so the subscription IS the wiring.
    // No teardown: the emitter drops subscribers when its host directive is destroyed with the component.
    this.fileDrop.filesDropped.subscribe((files) => this.onFilesDropped(files));

    // The sheet is a CDK overlay outside the router outlet, so it outlives this list.
    // `resetOnRoomChange` is not enough: settings, logout and deep links destroy the timeline
    // WITHOUT a room id change, leaving a modal whose rows dispatch into a destroyed component.
    // Scoped to `this`, so the thread panel's sheet stays.
    this.listDestroyRef.onDestroy(() => this.messageSheet.close(this));

    // Reset per-room state on room change. Created before any subclass scroll effect so it runs
    // FIRST (effects fire in creation order) and the scroll effect sees a fresh load.
    effect(() => {
      this.roomId();
      untracked(() => this.resetOnRoomChange());
    });

    // A jump requested before its row exists (a linked message in a still-syncing room) is
    // remembered and applied once the row loads; a newer request replaces it.
    effect(() => {
      this.jumpToNonce();
      const id = this.jumpToId();
      untracked(() => {
        if (!id) this.cancelPendingJump();
        this.awaitedJumpId =
          id && !this.messages().some((m) => m.id === id) ? id : null;
        this.awaitedJumpAt = Date.now();
      });
    });
    effect(() => {
      const loaded = this.messages();
      const id = this.awaitedJumpId;
      if (!id || !loaded.some((m) => m.id === id)) return;
      this.awaitedJumpId = null;
      // Bounded like a width re-apply: a row paged in minutes later must not yank the reader back.
      if (Date.now() - this.awaitedJumpAt > JUMP_REAPPLY_MS) return;
      afterNextRender(() => this.jumpTo(id), { injector: this.injector });
    });

    // Re-evaluate the jump-to-unread pill when the unread anchor or message set changes. Deferred
    // a frame so the divider is laid out; cancelled on re-run so a burst of sync ticks between
    // frames does not queue one forced-layout measurement each on the hottest surface.
    effect((onCleanup) => {
      this.firstUnreadId();
      this.messages();
      const handle = requestAnimationFrame(() => this.updateJumpToUnread());
      onCleanup(() => cancelAnimationFrame(handle));
    });
  }

  /**
   * Show the jump-to-unread pill while there are unread messages and the "New messages" divider
   * is outside the viewport. Called from each list's scroll handler and on unread-anchor change.
   */
  protected updateJumpToUnread(): void {
    const id = this.firstUnreadId();
    const scroll = this.scrollEl()?.nativeElement;
    if (!id || !scroll) {
      this.showJumpToUnread.set(false);
      return;
    }
    const divider = scroll.querySelector<HTMLElement>(
      '[data-testid="new-messages-divider"]',
    );
    if (!divider) {
      // Not rendered (outside the windowed viewport), so off-screen: offer the jump.
      this.showJumpToUnread.set(true);
      return;
    }
    const viewTop = scroll.scrollTop;
    const viewBottom = viewTop + scroll.clientHeight;
    const pos = divider.offsetTop;
    this.showJumpToUnread.set(pos < viewTop || pos > viewBottom);
  }

  /** Scroll the "New messages" divider (first unread) into view. */
  jumpToUnread(): void {
    const id = this.unreadRowId();
    if (id) {
      this.jumpTo(id);
    }
  }

  /**
   * Jump to a target someone asked for (reply preview, permalink, search hit, pinned message,
   * notification), starting it expanded. Positioning at the first unread ({@link jumpToUnread})
   * does not expand. If expansion grows an on-screen row, scroll after the render that shows it
   * whole, so the list scrolls once.
   */
  protected jumpToRequested(id: string): void {
    this.jumpTo(id, { afterRender: this.expandJumpTarget(id) });
  }

  /** Start a jump target expanded; true when that changed its state (the row will grow). */
  private expandJumpTarget(id: string): boolean {
    const store = this.expandedBodies;
    if (!store || store.isExpanded(id)) return false;
    store.expand(id);
    return true;
  }

  /** Reset per-room state on a room switch. Subclasses override to add scroll state. */
  protected resetOnRoomChange(): void {
    // A sheet is about ONE message in ONE room; it must not stand over another room's timeline.
    this.messageSheet.close(this);
    this.cancelPendingJump();
    this.announcement.set('');
    this.rowModel.reset();
  }

  /**
   * Briefly highlight a just-jumped-to row. Forces a reflow so a repeat jump to the same row
   * restarts the animation; self-clears on `animationend`.
   */
  protected flash(el: Element | null | undefined): void {
    // A re-aim lands on a row the reader already saw flash; flashing again is flicker.
    if (!el || this.reaiming) {
      return;
    }
    el.classList.remove('msg--flash');
    void (el as HTMLElement).offsetWidth; // reflow to restart the CSS animation
    el.classList.add('msg--flash');
    el.addEventListener(
      'animationend',
      () => el.classList.remove('msg--flash'),
      {
        once: true,
      },
    );
  }

  startEdit(row: MessageRow): void {
    this.messageCommands.beginEdit(row.id, row.body);
  }

  startReply(row: MessageRow): void {
    this.messageCommands.beginReply(row.id);
  }

  cancelEdit(): void {
    if (this.compose.intent().kind === 'edit') this.compose.cancelIntent();
  }

  cancelReply(): void {
    if (this.compose.intent().kind === 'reply') this.compose.cancelIntent();
  }

  /**
   * Pull a message's text into the composer as a `>` block.
   *
   * Leaves `replyingToId` alone (a quote is content, not a send target). Editing IS cancelled:
   * the composer holds the edited body there, so a quote would rewrite the original.
   */
  startQuote(row: MessageRow): void {
    this.cancelEdit();
    this.composer()?.insertQuote(quoteBlock(row.body));
  }

  /** Edit the most recent editable message of the current user (Up-arrow shortcut). */
  editLastOwn(): void {
    const msgs = this.messages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (isEditableMessage(msgs[i])) {
        this.messageCommands.beginEdit(msgs[i].id, msgs[i].body);
        return;
      }
    }
  }

  /**
   * The row a jump most recently aimed at, and the scroller width it was aimed at.
   *
   * `scrollIntoView` resolves to a scrollTop valid only for the layout at that instant. A width
   * change afterwards (closing a right-hand panel, a pane drag) re-wraps every row, so the jump
   * now lands on a different message. The browser's layout and `ResizeObserver` timing cannot be
   * relied on, so the jump is remembered and RE-APPLIED when the width actually changes, bounded
   * by {@link JUMP_REAPPLY_MS} so a late width change does not yank the reader back.
   */
  private pendingJumpId: string | null = null;
  private pendingJumpAt = 0;
  private reaiming = false;
  private userScrollWatched = false;
  private lastScrollerWidth = 0;
  private widthRo?: ResizeObserver;
  private stopHeightWatcher?: () => void;

  /** Remember a jump so a width change can re-apply it. Called BY `jumpTo`, not instead of it. */
  protected notePendingJump(messageId: string): void {
    this.pendingJumpId = messageId;
    // A re-aim keeps the original deadline: renewing it would let measurements or a drag hold the reader.
    if (!this.reaiming) this.pendingJumpAt = Date.now();
  }

  /** Stop re-aiming and drop a jump still waiting for its row (reader moved, or superseded). */
  protected cancelPendingJump(): void {
    this.pendingJumpId = null;
    this.awaitedJumpId = null;
  }

  /**
   * Re-aim a recent jump at the layout that now exists (width change, or first real row
   * measurements), within {@link JUMP_REAPPLY_MS} of the original jump and never extended.
   */
  protected reapplyRecentJump(): void {
    const id = this.pendingJumpId;
    if (id && Date.now() - this.pendingJumpAt <= JUMP_REAPPLY_MS) {
      this.reaiming = true;
      try {
        this.jumpTo(id);
      } finally {
        this.reaiming = false;
      }
    } else {
      this.pendingJumpId = null;
    }
  }

  /** Any reader-driven scroll (wheel, touch, keys, scrollbar drag) ends re-aiming. */
  private watchUserScroll(el: HTMLElement): void {
    if (this.userScrollWatched) return;
    this.userScrollWatched = true;
    const stop = () => this.cancelPendingJump();
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    for (const type of events) {
      el.addEventListener(type, stop, { passive: true });
    }
    this.listDestroyRef.onDestroy(() => {
      for (const type of events) el.removeEventListener(type, stop);
    });
  }

  /**
   * Watch the scroller's width and re-aim a recent jump when it changes (windowed mode also
   * re-aims after row measurements), and start the reader-scroll watcher that ends re-aiming.
   *
   * Width only: a height change is the keyboard or composer, and re-jumping would fight the reader.
   */
  protected watchScrollerWidth(): void {
    const el = this.scrollEl()?.nativeElement;
    if (el) this.watchUserScroll(el);
    if (!el || typeof ResizeObserver === 'undefined' || this.widthRo) {
      return;
    }
    this.lastScrollerWidth = el.clientWidth;
    this.widthRo = new ResizeObserver(() => {
      const width = el.clientWidth;
      if (width === this.lastScrollerWidth) {
        return;
      }
      this.lastScrollerWidth = width;
      this.reapplyRecentJump();
    });
    this.widthRo.observe(el);
    this.listDestroyRef.onDestroy(() => this.widthRo?.disconnect());
  }

  /**
   * Keep a bottom-pinned conversation pinned when the composer, formatting bar or software
   * keyboard changes the viewport height. A reader scrolled up needs no compensation. This exact
   * pin is separate from the 120px near-bottom state for incoming messages; the optional callback
   * keeps windowed mode's window-height signal in step.
   */
  protected watchScrollerHeight(
    resized?: (height: number, scrollTop: number) => void,
    wrote?: (delta: number) => void,
  ): void {
    const el = this.scrollEl()?.nativeElement;
    if (!el || this.stopHeightWatcher) {
      return;
    }
    this.stopHeightWatcher = observeScrollerHeight(el, resized, wrote);
    this.listDestroyRef.onDestroy(() => this.stopHeightWatcher?.());
  }

  /**
   * Scroll a message into view (per strategy). With `afterRender`, a row already in the DOM is
   * scrolled to after the next render, because the caller has just changed its height.
   */
  abstract jumpTo(messageId: string, options?: JumpOptions): void;

  /**
   * Per-row caps keyed by event id, memoized so the reference is stable across change-detection
   * ticks: `rowCaps()` runs in an `@for` on every CD, and a fresh object would defeat the OnPush
   * `MessageRowComponent`.
   */
  private readonly rowCapsById = computed<Map<string, MessageRowCaps>>(() => {
    this.prevRowCaps = buildRowCapsMap(
      this.messages(),
      {
        canRedactOthers: this.canRedactOthers(),
        canPin: this.canPin(),
        canThread: true,
        pinnedIds: this.pinnedIds(),
        canAddToEmoji: addableImages(this.addToEmoji),
      },
      this.prevRowCaps,
    );
    return this.prevRowCaps;
  });

  /** Last computed caps, for identity reuse (mirrors the row cache in {@link MessageRowModel}). */
  private prevRowCaps = new Map<string, MessageRowCaps>();

  /** Per-row capabilities/state for {@link MessageRowComponent} in the main timeline. */
  rowCaps(row: MessageRow): MessageRowCaps {
    return this.rowCapsById().get(row.id) ?? DEFAULT_ROW_CAPS;
  }

  /**
   * The fix Trust offers for an unreadable message; resolved only while some row can use it, so a
   * timeline with no fixable message does not depend on Trust.
   */
  readonly undecryptableFix = computed<UndecryptableFix | null>(() =>
    this.messages().some((message) => message.undecryptable?.deviceFixable)
      ? this.injector.get(UndecryptableFixService).fix()
      : null,
  );

  /**
   * Dispatch the semantic action the row captured when its drag committed. Does not re-read
   * `rowCaps`: the row may have left the window or caps map, while `action` is what the reader committed.
   */
  onRowSwipe(row: MessageRow, action: MessageSwipeAction): void {
    this.haptics.gestureCommitted();
    if (action === 'edit') {
      this.startEdit(row);
      return;
    }
    this.startReply(row);
  }

  /**
   * A long press on a row (phone or tablet): offer its actions as a bottom sheet.
   *
   * The sheet is held by {@link MessageActionSheetService} because `trn-message-row` has a third
   * consumer that does not extend this class. Dispatch goes through `onRowAction`, like the hover toolbar.
   */
  onRowLongPress(row: MessageRow, context?: MessageLongPressContext): void {
    this.messageSheet.open(
      this,
      this.rowCaps(row),
      (action) => this.onRowAction(row, action),
      context,
    );
  }

  /** Route a single row action to its handler / upward output. */
  onRowAction(row: MessageRow, action: MessageRowAction): void {
    if (
      dispatchSharedRowAction(action, row, {
        roomId: this.roomId() ?? '',
        accountId: this.accountId(),
        destroyRef: this.listDestroyRef,
        dialog: this.dialog,
        timeline: this.timeline,
        forward: this.forwardSvc,
        report: this.reportSvc,
        mediaSave: this.mediaSave,
        reactions: this.reactionsDialog,
        editHistory: this.editHistorySvc,
        // Resolved on use, like the computed above.
        addToEmoji: this.addToEmoji,
        undecryptableFix: {
          open: () => this.injector.get(UndecryptableFixService).open(),
        },
        react: (id, key) => this.react.emit({ id, key }),
        quote: (r) => this.startQuote(r),
        // No anchor: the dialog that held the link has closed, so the user card is centred.
        onHistoryLink: (target) => this.matrixLink.emit({ target }),
      })
    ) {
      return;
    }
    switch (action.type) {
      case 'reply':
        this.startReply(row);
        break;
      case 'edit':
        this.startEdit(row);
        break;
      case 'delete':
        void this.onDelete(row);
        break;
      case 'pin':
        this.togglePin.emit(row.id);
        break;
      case 'retry':
        this.retry.emit(row.id);
        break;
      case 'cancel':
        this.cancelSend.emit(row.id);
        break;
      case 'jump':
        this.jumpToRequested(action.id);
        break;
      case 'thread':
        this.openThread.emit(row.id);
        break;
      default: {
        // Exhaustiveness guard: a new MessageRowAction variant without a case is a compile error.
        const unhandled: never = action;
        void unhandled;
        break;
      }
    }
  }

  onDelete(row: MessageRow): void {
    confirmMessageDeletion$(this.alert)
      .pipe(takeUntilDestroyed(this.listDestroyRef))
      .subscribe(() => this.deleteMessage.emit(row.id));
  }

  /**
   * A batch caption, posted plainly. NOT routed through {@link onSubmit}: it was written before an
   * upload that may have taken minutes, so a since-started edit or reply is not what it belongs to.
   */
  protected onBatchCaption({ text, mentions }: ComposerSubmit): void {
    this.send.emit({ body: text, mentions });
  }

  onSubmit({ text, mentions }: ComposerSubmit): void {
    if (this.compose.sending()) return;
    this.send.emit({ body: text, mentions });
  }
}
