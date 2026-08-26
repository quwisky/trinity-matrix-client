import {
  DestroyRef,
  Directive,
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
import { TrnAlertService } from '@trinity/components/overlay';
import { MessageActionSheetService } from '../message-actions/message-action-sheet.service';
import { ReactionPickerService } from '../reaction-picker/reaction-picker.service';
import { type MatrixLinkClick } from '../matrix-link/matrix-link.directive';
import { ForwardService } from '../forward/forward.service';
import { ReportService } from '../report/report.service';
import { MessageSourceService } from '../message-source/message-source.service';
import { EditHistoryDialogService } from '../edit-history/edit-history.service';
import { ReactionsDialogService } from '../reactions-dialog/reactions-dialog.service';
import { type ThreadSummary } from '@trinity/data-access/timeline';
import {
  dayLabel,
  hasUsableTimestamp,
  isEditableMessage,
  isQuotableMessage,
  messagePermalink,
  quoteBlock,
  startOfLocalDay,
  type MessageView,
  type Mention,
} from '@trinity/util/matrix';
import {
  DateTimeFormatService,
  HapticsService,
} from '@trinity/platform-native';
import { DayBoundaryService } from './day-boundary.service';
import { TrnFileDropDirective } from '../shared/file-drop.directive';
import { delayedBusy } from '@trinity/util/ui';
import {
  type BatchItem,
  type BatchOutcome,
  type BatchProgress,
} from '../shared/send-media-batch';
import {
  type MessageRow,
  type MessageRowAction,
  type MessageRowCaps,
  type SwipeDirection,
} from '../message-row/message-row.component';
import {
  MessageComposerComponent,
  type ComposerSubmit,
  type MentionMember,
} from '../message-composer/message-composer.component';

/**
 * How long after a jump a width change still counts as "the same jump".
 *
 * Long enough to cover a panel closing and a pane being dragged, short enough that resizing
 * the window later is not answered by scrolling somewhere the reader left behind.
 */
const JUMP_REAPPLY_MS = 3_000;

/** Fallback caps for a row not present in the memoized map (defensive; unreached). */
const DEFAULT_ROW_CAPS: MessageRowCaps = {
  editable: false,
  deletable: false,
  canPin: false,
  pinned: false,
  canThread: true,
  canQuote: false,
  readOnly: false,
};

/** A memoized row, with the inputs it was derived from (see {@link MessageListBase.rows}). */
interface RowCacheEntry {
  readonly view: MessageView;
  readonly showHeader: boolean;
  readonly daySeparator: string | null;
  readonly row: MessageRow;
}

/** Whether two caps carry the same capabilities — all seven fields are flat booleans. */
function sameRowCaps(a: MessageRowCaps, b: MessageRowCaps): boolean {
  return (
    a.editable === b.editable &&
    a.deletable === b.deletable &&
    a.canPin === b.canPin &&
    a.pinned === b.pinned &&
    a.canThread === b.canThread &&
    a.canQuote === b.canQuote &&
    a.readOnly === b.readOnly
  );
}

/**
 * Shared domain logic for the room timeline, independent of scroll strategy: the
 * inputs/outputs, the edit/reply state + action handlers, and the Discord-style row
 * grouping. {@link SimpleMessageListComponent} (plain scroll) and
 * {@link VirtualMessageListComponent} (windowed) extend this and add only their own
 * scroll container, effects and template — the feature flag selects which one the
 * room renders. Kept an abstract `@Directive()` (no selector) so Angular wires the
 * inherited inputs/outputs/queries for the subclasses.
 */
@Directive()
export abstract class MessageListBase {
  readonly messages = input<MessageView[]>([]);
  /** Thread summaries keyed by root event id, for the per-row thread indicator. */
  readonly threadSummaries = input<Record<string, ThreadSummary>>({});
  /** Whether the current user may pin/unpin in this room (drives the per-row Pin item). */
  readonly canPin = input(false);
  /** Whether the current user may redact OTHER people's messages here (a moderator). */
  readonly canRedactOthers = input(false);
  /** Currently-pinned event ids, for the per-row pinned state. */
  readonly pinnedIds = input<readonly string[]>([]);
  readonly loadingOlder = input(false);
  /**
   * Gates the appearance of the "Loading older messages…" strip, and nothing else.
   *
   * `minimumMs: 0` is load-bearing, not a tuning choice — but not on the way OUT, which is
   * what it looks like. The AND in {@link showLoadingOlder} is what makes the strip vanish
   * in the same change-detection pass the prepend lands in, and it does that whatever this
   * is set to. What a minimum hold changes is the NEXT backfill: scrolling back is
   * repetitive, one slow page is routinely followed by several fast ones, and a
   * `delayedBusy` still serving out a hold is still "visible" — so the load after it skips
   * the delay entirely and flashes the strip for a page nobody noticed was fetched, which is
   * the exact flicker the delay exists to prevent. Zero ends the hold with the load, so
   * every backfill is judged on its own duration.
   *
   * Why the removal has to be synchronous at all: the strip is IN FLOW above the rows, and
   * `VirtualMessageListComponent.rowsRegionTop()` folds its height into the scroll restore
   * that keeps the reader's place across a prepend. `TimelineService.loadOlder` prepends the
   * rows and clears `loadingOlder` in one synchronous block, so a strip held past that point
   * has the restore measure 36px that is about to disappear — and `.scroll` sets
   * `overflow-anchor: none`, so nothing compensates when it does: the content jumps up by
   * the strip's height, in the exact spot being read.
   */
  private readonly loadingOlderSettled = delayedBusy(
    this.loadingOlder,
    inject(Injector),
    { minimumMs: 0 },
  );

  /**
   * `loadingOlder`, shaped for the eye: nothing at all for a fast backfill.
   *
   * Backfilling a page of history is usually quicker than a person can register, so binding
   * the raw input flashed the strip on most scrolls back — motion at the top of the timeline,
   * in the exact spot the reader is looking, for a load they never noticed was happening.
   *
   * The raw input is ANDed in deliberately: it makes the strip's removal synchronous with the
   * prepend, exactly as it was before any of this, while the delayed signal decides only
   * whether it was ever worth showing. The residual is a load landing just past the delay,
   * which shows the strip briefly — much rarer than the flicker it replaced, and the only
   * alternative moves the reader's content.
   */
  protected readonly showLoadingOlder = computed(
    () => this.loadingOlder() && this.loadingOlderSettled(),
  );
  readonly canLoadOlder = input(false);
  /** Oldest RAW event in the loaded window — the backfill progress marker (see
   * TimelineService.oldestEventId). Not the oldest rendered row: rows can be filtered out. */
  readonly oldestEventId = input<string | null>(null);
  readonly roomName = input('');
  /**
   * Active room id. The list instance is reused across room switches, so a change
   * here resets the per-room UI + scroll state (see {@link resetOnRoomChange}) —
   * otherwise a pending edit/reply target and the scroll anchors leak between rooms.
   */
  readonly roomId = input<string | null>(null);
  /** Room members, forwarded to the composer's @-mention autocomplete. */
  readonly members = input<readonly MentionMember[]>([]);
  /** Display names of members currently typing in the room (excludes the local user). */
  readonly typingNames = input<string[]>([]);
  /**
   * Event id of the first unread message — a "New messages" divider renders before it,
   * and a jump-to-unread pill appears while it's off-screen. Null when nothing is unread.
   */
  readonly firstUnreadId = input<string | null>(null);
  /** Which file of how many is uploading and how far along, or null when idle. */
  readonly uploadProgress = input<BatchProgress | null>(null);
  /**
   * Event id to scroll into view, set by an external jump (e.g. in-room search).
   * A no-op when the event isn't in the loaded timeline.
   */
  readonly jumpToId = input<string | null>(null);
  /**
   * Bumped by the host on every jump request. Paired with {@link jumpToId} so that
   * re-requesting the SAME event id (e.g. clicking the same pinned message twice)
   * still changes an input and re-fires the jump effect — an unchanged `jumpToId`
   * alone would be an Object.is no-op and never re-run.
   */
  readonly jumpToNonce = input(0);
  readonly loadOlder = output<void>();
  /** Open the thread rooted at this event id (raised by a row's indicator). */
  readonly openThread = output<string>();
  /** Pin or unpin this event id (host resolves which, given its current pinned state). */
  readonly togglePin = output<string>();
  readonly send = output<{ body: string; mentions: Mention[] }>();
  /**
   * Send a batch of staged attachments. `onOutcomes` reports back per item, so the composer
   * can drop the delivered ones and keep the rest staged for a retry — and it MUST be called
   * by whoever performs the send, because it also releases the one-at-a-time send latch.
   */
  readonly sendMedia = output<{
    items: readonly BatchItem[];
    caption: string;
    onOutcomes: (outcomes: readonly BatchOutcome[]) => void;
  }>();
  readonly retry = output<string>();
  readonly editMessage = output<{
    id: string;
    body: string;
    mentions: Mention[];
  }>();
  readonly deleteMessage = output<string>();
  readonly react = output<{ id: string; key: string }>();
  readonly reply = output<{ id: string; body: string; mentions: Mention[] }>();
  /** The composer's typing state changed — host debounces it into a typing notification. */
  readonly typing = output<boolean>();
  /** A `matrix.to` permalink clicked in a message body, for the host to route in-app. */
  readonly matrixLink = output<MatrixLinkClick>();
  /** A vote cast on a poll (the host sends the response). */
  readonly pollVote = output<{ pollId: string; answerId: string }>();
  /** A request to close a poll (the host sends the end event). */
  readonly pollEnd = output<string>();

  readonly editingId = signal<string | null>(null);
  readonly editingDraft = computed(
    () => this.messages().find((m) => m.id === this.editingId())?.body ?? '',
  );

  readonly replyingToId = signal<string | null>(null);
  readonly replyingToName = computed(
    () =>
      this.messages().find((m) => m.id === this.replyingToId())?.senderName ??
      '',
  );

  /** Live-region text announcing a newly-arrived incoming message to screen readers. */
  readonly announcement = signal('');

  /** Whether the jump-to-unread pill is shown — true while unread exist and the
   * "New messages" divider is scrolled out of the viewport. */
  readonly showJumpToUnread = signal(false);

  /**
   * Files dragged onto the conversation. Handled here rather than in each list because the
   * drop directive is a host directive on both, and staging is identical for both.
   */
  protected readonly fileDrop = inject(TrnFileDropDirective);
  protected readonly alert = inject(TrnAlertService);
  private readonly dayBoundary = inject(DayBoundaryService);
  private readonly dateFormat = inject(DateTimeFormatService);
  private readonly reactionPicker = inject(ReactionPickerService);
  private readonly forwardSvc = inject(ForwardService);
  private readonly reportSvc = inject(ReportService);
  private readonly sourceSvc = inject(MessageSourceService);
  private readonly editHistorySvc = inject(EditHistoryDialogService);
  private readonly reactionsDialog = inject(ReactionsDialogService);
  private readonly messageSheet = inject(MessageActionSheetService);
  private readonly haptics = inject(HapticsService);

  /**
   * Which way a row is dragged to act on it, resolved by the page and passed straight down.
   *
   * The page owns it because the answer depends on the drawer, which neither the list nor
   * the row can see. `'off'` means the gesture does not arm at all — no listeners doing
   * anything, no row movement — rather than a drag that moves and is then refused.
   */
  readonly swipeDirection = input<SwipeDirection>('off');
  protected readonly scrollEl = viewChild<ElementRef<HTMLElement>>('scroll');

  /**
   * The composer rendered by each concrete list, so a quote can be put into it directly —
   * and so a file dropped on the conversation reaches the same staging the picker fills.
   */
  private readonly composer = viewChild(MessageComposerComponent);

  /**
   * Stage files dropped on the conversation.
   *
   * Routed through the composer rather than the attachments service directly: that service is
   * provided BY the composer, so it does not exist at this level, and going through the
   * component keeps one definition of what staging means (and of when it is refused).
   */
  protected onFilesDropped(files: readonly File[]): void {
    this.composer()?.stageFiles(files);
  }

  // Grouping rows, cached per event id so an unchanged message (same view object, same
  // header flag AND same day-separator label) keeps its row identity — an OnPush row is
  // then re-rendered only when its own message, grouping or separator changes, not on
  // every live event in the room.
  private rowCache = new Map<string, RowCacheEntry>();

  /**
   * Group consecutive messages from the same sender (Discord-style), and mark where the
   * local calendar day changes.
   *
   * Both are derived over the FULL list. The windowed list renders a `slice()` of this, so
   * anything derived from "the previous *rendered* row" would emit a spurious separator at
   * the top of every window and lose the one where a window opens mid-day.
   */
  readonly rows = computed<MessageRow[]>(() => {
    const GAP_MS = 5 * 60 * 1000;
    const msgs = this.messages();
    const todayStart = this.dayBoundary.todayStart();
    // Read unconditionally rather than inside the day-change branch below: a window that
    // happens to span a single day must still re-derive when the format preference moves, or
    // the first separator to appear after a backfill would carry the old one.
    const dateFormat = this.dateFormat.prefs();
    const nextCache = new Map<string, RowCacheEntry>();
    // The calendar day the rows so far belong to, or null before the first row with a
    // usable timestamp. A row whose timestamp is missing or implausible (a malformed event
    // degraded to `timestamp: 0` by safeBuildMessageView) neither opens nor closes a day:
    // it inherits this, so it mints no 1970 separator AND the next real row is still
    // compared against the last real day rather than against 1970.
    let currentDayStart: number | null = null;
    const result = msgs.map((m, i) => {
      const prev = msgs[i - 1];

      let daySeparator: string | null = null;
      if (hasUsableTimestamp(m.timestamp)) {
        const dayStart = startOfLocalDay(m.timestamp);
        // Nothing above the FIRST row: the loaded window is an arbitrary slice of the
        // room's history, so "the day changed here" only means something relative to a row
        // we are actually showing. A separator at the top would also jump to a different
        // row on every page of backfilled history.
        if (currentDayStart !== null && dayStart !== currentDayStart) {
          daySeparator = dayLabel(dayStart, todayStart, dateFormat);
        }
        currentDayStart = dayStart;
      }

      const showHeader =
        !prev ||
        // A system (state/membership) line breaks the group, so the next message
        // re-shows its author even when it's from the same sender.
        prev.kind === 'event' ||
        prev.senderId !== m.senderId ||
        m.timestamp - prev.timestamp > GAP_MS ||
        // Same reason a system line breaks the group: two messages either side of midnight
        // can be seconds apart, and a headerless continuation directly under a day
        // separator reads as if the message lost its author.
        daySeparator !== null ||
        // A reply always shows its own header: the quoted preview breaks the visual
        // flow, so a headerless continuation would look like the reply lost its
        // author (name + avatar).
        !!m.replyTo;

      const cached = this.rowCache.get(m.id);
      const row =
        cached &&
        cached.view === m &&
        cached.showHeader === showHeader &&
        cached.daySeparator === daySeparator
          ? cached.row
          : { ...m, showHeader, daySeparator };
      nextCache.set(m.id, { view: m, showHeader, daySeparator, row });
      return row;
    });
    this.rowCache = nextCache;
    return result;
  });

  /**
   * Declared ABOVE the constructor on purpose. The constructor registers an `onDestroy` on
   * it, which works wherever the field sits — every initializer runs before the constructor
   * body — but TS2729 only guards field initializers, not constructor bodies, so the
   * compiler would not catch it if this drifted below a subclass. Keeping the two adjacent
   * removes the question.
   */
  private readonly listDestroyRef = inject(DestroyRef);

  constructor() {
    // A host directive's outputs are not template-bound, so the subscription IS the wiring.
    // No teardown: an `OutputEmitterRef` drops its subscribers when its own directive is
    // destroyed, and a host directive is destroyed with the component it is attached to.
    this.fileDrop.filesDropped.subscribe((files) => this.onFilesDropped(files));

    // The sheet is a CDK overlay, which lives OUTSIDE the router outlet and so outlives
    // this list. `resetOnRoomChange` cannot be the only place it is shut: a route to
    // settings, a logout redirect and a deep link all destroy the timeline WITHOUT the
    // room id changing, leaving a modal standing whose every row dispatches into a
    // destroyed component. Scoped to `this`, so it never shuts the thread panel's sheet.
    this.listDestroyRef.onDestroy(() => this.messageSheet.close(this));

    // Reset per-room state when the active room changes. Created here — before any
    // scroll effect a subclass adds in its own constructor — so it runs FIRST
    // (effects fire in creation order), letting the scroll effect treat the new room
    // as a fresh load. Subclasses override resetOnRoomChange() to also clear their
    // scroll/windowing state.
    effect(() => {
      this.roomId();
      untracked(() => this.resetOnRoomChange());
    });

    // Re-evaluate the jump-to-unread pill when the unread anchor or the message set
    // changes (e.g. the divider row (dis)appears). Deferred a frame so the row/divider
    // is laid out before we measure it. Cancelled on re-run: a burst of sync ticks
    // between two frames would otherwise queue one forced-layout measurement each, on
    // the hottest surface in the app, all computing the same answer.
    effect((onCleanup) => {
      this.firstUnreadId();
      this.messages();
      const handle = requestAnimationFrame(() => this.updateJumpToUnread());
      onCleanup(() => cancelAnimationFrame(handle));
    });
  }

  /**
   * Show the jump-to-unread pill while there are unread messages whose "New messages"
   * divider is not currently within the viewport (so on open — pinned to the bottom with
   * unread above — it shows; scrolling the divider into view hides it). Called from each
   * list's scroll handler and when the unread anchor changes.
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
      // Not rendered — the (windowed) viewport doesn't include the divider, so it's
      // off-screen: offer the jump.
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
    const id = this.firstUnreadId();
    if (id) {
      this.jumpTo(id);
    }
  }

  /** Reset per-room state on a room switch. Subclasses override to add scroll state. */
  protected resetOnRoomChange(): void {
    // A sheet is about ONE message in ONE room; leaving it standing over a different
    // room's timeline would offer actions against an event that is no longer on screen.
    this.messageSheet.close(this);
    this.editingId.set(null);
    this.replyingToId.set(null);
    this.announcement.set('');
    this.rowCache.clear();
  }

  /**
   * Briefly highlight a just-jumped-to message row (after `jumpTo` scrolls it into
   * view) so the eye lands on it. Resets any in-flight flash with a forced reflow so a
   * repeat jump to the same row re-triggers the animation, and self-clears on
   * `animationend`.
   */
  protected flash(el: Element | null | undefined): void {
    if (!el) {
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
    this.replyingToId.set(null);
    this.editingId.set(row.id);
  }

  startReply(row: MessageRow): void {
    this.editingId.set(null);
    this.replyingToId.set(row.id);
  }

  /**
   * Pull a message's text into the composer as a `>` block.
   *
   * Leaves `replyingToId` alone: a quote is composer content, not a send target, so
   * quoting while replying keeps the reply — the two compose. Editing IS cancelled,
   * because the composer holds the edited message's body there and inserting a quote into
   * it would rewrite the original rather than answer it.
   */
  startQuote(row: MessageRow): void {
    this.editingId.set(null);
    this.composer()?.insertQuote(quoteBlock(row.body));
  }

  /** A message the current user can still edit (own, confirmed, text — not media). */
  isEditable(m: MessageView): boolean {
    return isEditableMessage(m);
  }

  /** Whether a row's event id is currently pinned. */
  isPinned(id: string): boolean {
    return this.pinnedIds().includes(id);
  }

  /** Edit the most recent editable message of the current user (Up-arrow shortcut). */
  editLastOwn(): void {
    const msgs = this.messages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (this.isEditable(msgs[i])) {
        this.editingId.set(msgs[i].id);
        return;
      }
    }
  }

  onCopy(row: MessageRow): void {
    void navigator.clipboard?.writeText(row.body);
  }

  /** Copy a matrix.to permalink to this message. */
  onCopyLink(row: MessageRow): void {
    void navigator.clipboard?.writeText(
      messagePermalink(this.roomId() ?? '', row.id),
    );
  }

  /**
   * The row a jump most recently aimed at, and the scroller width it was aimed at.
   *
   * A jump ends in `scrollIntoView`, which is a measurement: it resolves to a scrollTop that
   * is only correct for the layout at that instant. Change the scroller's WIDTH afterwards
   * and every row re-wraps to a new height, so the position the jump computed now belongs to
   * a different message — the reader is left somewhere near, or nowhere near, with only the
   * flash to say the jump happened.
   *
   * That is not hypothetical: it is what closing a right-hand panel does, since the panel and
   * the timeline share the row, and it is what a pane drag will do continuously. Rather than
   * time the jump against the reflow — which cannot be done reliably, because the browser
   * lays out and fires `ResizeObserver` on its own schedule — the jump is remembered and
   * RE-APPLIED when the width actually changes.
   *
   * Bounded by {@link JUMP_REAPPLY_MS} so a width change minutes later does not yank someone
   * back to a message they have long scrolled past.
   */
  private pendingJumpId: string | null = null;
  private pendingJumpAt = 0;
  private lastScrollerWidth = 0;
  private widthRo?: ResizeObserver;

  /**
   * Remember a jump so a width change can re-apply it. Called BY the subclasses' `jumpTo`,
   * not instead of it — the base cannot know how each strategy scrolls.
   */
  protected notePendingJump(messageId: string): void {
    this.pendingJumpId = messageId;
    this.pendingJumpAt = Date.now();
  }

  /**
   * Watch the scroller's width and re-apply a recent jump when it changes.
   *
   * Width only: a height change is the keyboard opening or the composer growing, and
   * re-jumping there would fight the reader rather than help them. Started by the subclasses
   * once they have a scroll element, and torn down with the component.
   */
  protected watchScrollerWidth(): void {
    const el = this.scrollEl()?.nativeElement;
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
      const id = this.pendingJumpId;
      if (id && Date.now() - this.pendingJumpAt <= JUMP_REAPPLY_MS) {
        // Re-aim at the same row against the layout that now exists. `jumpTo` calls
        // `notePendingJump` again, which refreshes the deadline — deliberately, so a drag
        // that resizes continuously keeps the reader on their row for its whole duration.
        this.jumpTo(id);
      } else {
        this.pendingJumpId = null;
      }
    });
    this.widthRo.observe(el);
    this.listDestroyRef.onDestroy(() => this.widthRo?.disconnect());
  }

  /** Scroll a message into view (each scroll strategy implements it differently). */
  abstract jumpTo(messageId: string): void;

  /**
   * Per-row caps keyed by event id, memoized so the reference is stable across
   * change-detection ticks that don't touch pinning/permissions/the message set.
   * `rowCaps()` is called from an `@for` on every CD; returning a fresh object each
   * time would defeat the OnPush `MessageRowComponent` and re-render every row.
   */
  private readonly rowCapsById = computed<Map<string, MessageRowCaps>>(() => {
    const canPin = this.canPin();
    const canRedactOthers = this.canRedactOthers();
    const pinnedIds = this.pinnedIds();
    const caps = new Map<string, MessageRowCaps>();
    for (const message of this.messages()) {
      // An unsent message is only a local echo: its id is the SDK's `~roomId:txnId`
      // placeholder, which the homeserver has never seen. Threading off it would make
      // that placeholder the thread root — every reply then relates to an event the
      // server can't resolve — and pinning it would write it into `m.room.pinned_events`
      // room state. Both wait for the remote echo to swap in the real event id.
      const unsent = !!message.status;
      const next: MessageRowCaps = {
        editable: this.isEditable(message),
        // Own messages are always deletable; a moderator can also redact others'.
        deletable: (message.isOwn || canRedactOthers) && !unsent,
        canPin: canPin && !unsent,
        pinned: pinnedIds.includes(message.id),
        canThread: !unsent,
        canQuote: isQuotableMessage(message),
        readOnly: false,
      };
      // Reuse the previous object when nothing about this row's caps changed, exactly
      // as rowCache does for the row itself. `messages()` gets a NEW array identity on
      // every timeline event, so without this every incoming message would hand every
      // rendered row a fresh `caps` input and re-render it.
      const prev = this.prevRowCaps.get(message.id);
      caps.set(message.id, prev && sameRowCaps(prev, next) ? prev : next);
    }
    this.prevRowCaps = caps;
    return caps;
  });

  /** Last computed caps, for identity reuse (mirrors {@link rowCache}). */
  private prevRowCaps = new Map<string, MessageRowCaps>();

  /** Per-row capabilities/state for {@link MessageRowComponent} in the main timeline. */
  rowCaps(row: MessageRow): MessageRowCaps {
    return this.rowCapsById().get(row.id) ?? DEFAULT_ROW_CAPS;
  }

  /**
   * A committed sideways drag on a row: edit it if it can be edited, reply to it otherwise.
   *
   * Read from `rowCaps`, not from `isEditable`, and the distinction is the point: `rowCaps`
   * is what the row itself was handed, so the icon the reader saw behind the row and the
   * action they get are the same value rather than two computations of it.
   *
   * The action is dispatched here rather than by the row for the same reason the sheet is —
   * the row does not survive a redaction, an edit, the local-echo id swap, or scrolling out
   * of the virtual window, and `row` here is a snapshot the closure holds.
   */
  onRowSwipe(row: MessageRow): void {
    this.haptics.gestureCommitted();
    if (this.rowCaps(row).editable) {
      this.startEdit(row);
      return;
    }
    this.startReply(row);
  }

  /**
   * A long press on a row, on a phone or tablet: offer its actions as a bottom sheet.
   *
   * The sheet is built and held by {@link MessageActionSheetService}, not here, because
   * `trn-message-row` has a third consumer that does not extend this class — see that
   * service. What this method contributes is its caps and a dispatch closing over the row,
   * routed through `onRowAction` — the same path the hover toolbar takes.
   */
  onRowLongPress(row: MessageRow): void {
    this.messageSheet.open(this, this.rowCaps(row), (action) =>
      this.onRowAction(row, action),
    );
  }

  /** Route a single row action to its handler / upward output. */
  onRowAction(row: MessageRow, action: MessageRowAction): void {
    switch (action.type) {
      case 'react':
        this.react.emit({ id: row.id, key: action.key });
        break;
      case 'react-more':
        void this.pickReaction(row.id);
        break;
      case 'reply':
        this.startReply(row);
        break;
      case 'quote':
        this.startQuote(row);
        break;
      case 'copy':
        this.onCopy(row);
        break;
      case 'copy-link':
        this.onCopyLink(row);
        break;
      case 'view-source':
        this.sourceSvc.open(this.roomId() ?? '', row.id);
        break;
      case 'forward':
        void this.forwardSvc.forward(this.roomId() ?? '', row.id);
        break;
      case 'report':
        void this.reportSvc.report(this.roomId() ?? '', row.id);
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
      case 'jump':
        this.jumpTo(action.id);
        break;
      case 'thread':
        this.openThread.emit(row.id);
        break;
      case 'edit-history':
        void this.showEditHistory(row.id);
        break;
      case 'reactors':
        void this.reactionsDialog.open(row.id);
        break;
      default: {
        // Exhaustiveness guard: adding a MessageRowAction variant without a case
        // here becomes a compile error rather than a silently-dropped action.
        const unhandled: never = action;
        void unhandled;
        break;
      }
    }
  }

  /**
   * Show a message's earlier versions. A permalink followed inside the dialog comes back
   * here rather than being routed there, so it travels the same path as one clicked in
   * the timeline itself.
   */
  private async showEditHistory(id: string): Promise<void> {
    const followed = await this.editHistorySvc.openHistory(
      this.roomId() ?? '',
      id,
    );
    if (followed) {
      // No anchor: the dialog that held the link has already closed, so a user card from
      // here is centred rather than pinned to an element that no longer exists.
      this.matrixLink.emit({ target: followed });
    }
  }

  /** Open the full emoji picker and, on a pick, react to the message with it. */
  private async pickReaction(id: string): Promise<void> {
    const key = await this.reactionPicker.pick();
    if (key) {
      this.react.emit({ id, key });
    }
  }

  async onDelete(row: MessageRow): Promise<void> {
    const confirmed = await this.alert.confirm({
      header: 'Delete message',
      message: 'Delete this message? This cannot be undone.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (confirmed) {
      this.deleteMessage.emit(row.id);
    }
  }

  /** Composer submit — routes to an edit or reply when active, else a new send. */
  /**
   * A batch caption, posted plainly. Deliberately NOT routed through {@link onSubmit}: it was
   * written before an upload that may have taken minutes, so the edit or reply the user has
   * started since is not what it belongs to.
   */
  protected onBatchCaption({ text, mentions }: ComposerSubmit): void {
    this.send.emit({ body: text, mentions });
  }

  onSubmit({ text, mentions }: ComposerSubmit): void {
    const editId = this.editingId();
    const replyId = this.replyingToId();
    if (editId) {
      this.editMessage.emit({ id: editId, body: text, mentions });
      this.editingId.set(null);
    } else if (replyId) {
      this.reply.emit({ id: replyId, body: text, mentions });
      this.replyingToId.set(null);
    } else {
      this.send.emit({ body: text, mentions });
    }
  }
}
