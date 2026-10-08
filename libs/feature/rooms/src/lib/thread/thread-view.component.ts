import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { ThreadCommands } from './thread-commands';
import { SidePanelHeaderComponent } from '../side-panel/side-panel-header.component';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  buildRowCapsMap,
  dispatchSharedRowAction,
} from '../shared/row-actions';
import {
  HapticsService,
  MessageGestureSettingsService,
  isMobileOs,
} from '@trinity/platform-native';
import { MessageActionSheetService } from '../message-actions/message-action-sheet.service';
import {
  type MessageSwipeAction,
  type SwipeDirection,
} from '../message-row/message-row.component';
import { EmptyStateComponent } from '@trinity/components/generic-content';
import { TypingIndicatorComponent } from '../message-list/typing-indicator/typing-indicator.component';
import {
  TrnSurfaceService,
  TrnOverlaySurfaceDirective,
} from '@trinity/components/overlay';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { RoomMembersService } from '@trinity/data-access/room-administration';
import { quoteBlock } from '@trinity/util/matrix';
import {
  MessageRowComponent,
  type MessageLongPressContext,
  type MessageRow,
  type MessageRowAction,
  type MessageRowCaps,
} from '../message-row/message-row.component';
import {
  MessageComposerComponent,
  type ComposerSubmit,
} from '../message-composer/message-composer.component';
import { ForwardService } from '../forward/forward.service';
import { MediaSaveService } from '../media-attachment/media-save.service';
import { ReportService } from '../report/report.service';
import { EditHistoryDialogService } from '../edit-history/edit-history.service';
import { ReactionsDialogService } from '../reactions-dialog/reactions-dialog.service';
import {
  scrollBehavior,
  BELOW_MEMBERS_QUERY,
  mediaQuerySignal,
} from '@trinity/util/ui';

/** Group consecutive messages from the same sender within this window (Discord-style). */
const GROUP_GAP_MS = 5 * 60 * 1000;

/** Fallback caps for a row not present in the memoized map (defensive; unreached). */
const THREAD_ROW_CAPS: MessageRowCaps = {
  editable: false,
  deletable: false,
  canPin: false,
  pinned: false,
  canThread: false,
  canQuote: false,
  saveMedia: null,
  readOnly: false,
};

/**
 * Thread view: the root message plus its replies, with an in-thread composer.
 * Reuses the shared {@link MessageRowComponent} so a thread renders exactly like
 * the main timeline (avatars, markdown, media, reactions, the hover toolbar) and
 * the shared {@link MessageComposerComponent} so composing behaves identically
 * (Enter sends, edit/reply banners, emoji, attachments).
 *
 * Orchestration mirrors {@link MessageListComponent} but routes every action
 * through the exact {@link ConversationThread} child, whose commands carry the thread
 * relation so sends/edits/replies stay in the thread. Presentational: rendered in the
 * rooms shell's right-hand panel slot, with `roomId`/`rootEventId` as signal inputs; it
 * closes nothing itself, it announces {@link ThreadViewComponent.dismissed} and the
 * rooms page empties the slot.
 */
@Component({
  selector: 'trn-thread-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    SidePanelHeaderComponent,
    TypingIndicatorComponent,
    EmptyStateComponent,
    MessageRowComponent,
    MessageComposerComponent,
    TrnOverlaySurfaceDirective,
  ],
  providers: [ThreadCommands],
  templateUrl: './thread-view.component.html',
  styleUrl: './thread-view.component.scss',
})
export class ThreadViewComponent implements OnDestroy {
  private readonly conversations = inject(ConversationRuntime);
  private readonly commands = inject(ThreadCommands);
  private readonly openedThread = this.commands.thread;
  private readonly messageSheet = inject(MessageActionSheetService);
  private readonly roomMembers = inject(RoomMembersService);
  private readonly dialog = inject(TrnSurfaceService);
  private readonly forwardSvc = inject(ForwardService);
  private readonly reportSvc = inject(ReportService);
  private readonly mediaSave = inject(MediaSaveService);
  private readonly editHistorySvc = inject(EditHistoryDialogService);
  private readonly reactionsDialog = inject(ReactionsDialogService);
  private readonly timeline = this.conversations.timeline;
  private readonly destroyRef = inject(DestroyRef);

  readonly roomId = input.required<string>();
  readonly accountId = input<string | null>(null);
  readonly rootEventId = input.required<string>();
  /** The user closed the thread. There is nothing to pick here, so no `selected`. */
  readonly dismissed = output<void>();

  /** The room's members, for the thread composer's @-mention autocomplete. */
  readonly members = computed(() => {
    return this.roomMembers.membersFor(this.roomId())();
  });

  readonly editingId = this.commands.editingId;
  readonly replyingToId = this.commands.replyingToId;
  readonly uploadProgress = this.commands.uploadProgress;
  private readonly threadBinding = effect(() => {
    const roomId = this.roomId();
    const rootEventId = this.rootEventId();
    const current = this.openedThread();
    if (
      current?.key.roomId === roomId &&
      current.key.rootEventId === rootEventId
    ) {
      return;
    }
    if (current) {
      this.messageSheet.close(this);
      current.release();
      this.commands.reset();
      this.timeline.setTyping(false, 'thread');
    }
    this.openedThread.set(this.conversations.threads.forRoot(rootEventId));
  });

  private readonly scrollEl = viewChild<ElementRef<HTMLElement>>('scroll');

  /** The thread's own composer, so a quote lands in it rather than the room's. */
  private readonly composer = viewChild(MessageComposerComponent);

  /** The thread's messages (root first, then replies), grouped for display. */
  readonly rows = computed<MessageRow[]>(() => {
    const msgs = this.openedThread()?.messages() ?? [];
    return msgs.map((m, i) => {
      const prev = msgs[i - 1];
      const showHeader =
        !prev ||
        prev.senderId !== m.senderId ||
        m.timestamp - prev.timestamp > GROUP_GAP_MS ||
        // A reply always shows its own header: the quoted preview breaks the
        // visual flow, so a headerless continuation would look like the reply
        // lost its author (name + avatar).
        !!m.replyTo;
      return { ...m, showHeader };
    });
  });

  readonly editingDraft = computed(
    () =>
      this.openedThread()
        ?.messages()
        .find((m) => m.id === this.editingId())?.body ?? '',
  );

  readonly replyingToName = computed(
    () =>
      this.openedThread()
        ?.messages()
        .find((m) => m.id === this.replyingToId())?.senderName ?? '',
  );

  /** Whether older thread replies remain to be paged in. */
  readonly canLoadOlder = computed(
    () => this.openedThread()?.canLoadOlder() ?? false,
  );
  /** Whether an older-replies page is currently loading. */
  readonly loadingOlder = computed(
    () => this.openedThread()?.loadingOlder() ?? false,
  );

  ngOnDestroy(): void {
    // The sheet is a modal over this panel; leaving it standing would dispatch against a
    // thread that is no longer open.
    this.messageSheet.close(this);
    this.openedThread()?.release();
    this.openedThread.set(null);
    // Closing the panel mid-reply otherwise leaves us marked as typing until the server's
    // own TYPING_TIMEOUT_MS lapses. Owner-keyed, so this cannot clear the flag when the
    // main composer still holds a draft — which is why the naive one-liner was wrong.
    this.timeline.setTyping(false, 'thread');
  }

  /**
   * Which way a thread reply is dragged to act on it.
   *
   * Read from the preference DIRECTLY, unlike the main timeline, whose page forces the
   * gesture off while the drawer is open. This panel only exists while the drawer is open,
   * so that rule would leave the gesture permanently dead here — on the one device it is
   * for. The competition with the drawer's own close-drag is resolved at the row instead: an
   * armed swipe stops the `pointerdown` from reaching it. See `armSwipe`.
   *
   * Still phones only, and for the same reason: above `max-width: 1099.98px` the scroller
   * does not claim the horizontal axis and the browser eats the drag.
   */
  protected readonly swipeDirection = computed<SwipeDirection>(() =>
    this.belowMembers() && isMobileOs() ? this.gestures.messageSwipe() : 'off',
  );

  private readonly gestures = inject(MessageGestureSettingsService);
  private readonly haptics = inject(HapticsService);
  private readonly belowMembers = mediaQuerySignal(
    BELOW_MEMBERS_QUERY,
    inject(DestroyRef),
  );

  /**
   * Dispatch the semantic action the row captured when its sideways drag committed.
   *
   * The row snapshot remains valid after it leaves this panel's live caps map, so this
   * mirrors `MessageListBase.onRowSwipe` without revalidating capabilities and changing the
   * action after the reader has already committed it.
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
   * A long press on a thread reply, on a phone or tablet.
   *
   * Present for the same reason the timeline has one, and easy to forget: this component
   * renders `trn-message-row` but does NOT extend `MessageListBase`, so it inherits none of
   * that wiring. Without this the row emitted `longPress` into nothing and — the Android
   * `contextmenu` fallback having gone with it — every action on a thread reply was
   * unreachable by touch.
   */
  onRowLongPress(row: MessageRow, context?: MessageLongPressContext): void {
    this.messageSheet.open(
      this,
      this.rowCaps(row),
      (action) => this.onRowAction(row, action),
      context,
    );
  }

  /** Announce the close; the rooms page owns the slot and empties it. */
  close(): void {
    this.dismissed.emit();
  }

  /** Page in older replies for this thread (mirrors the timeline's load-older). */
  loadOlder(): void {
    this.openedThread()
      ?.loadOlder()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  onBatchCaption(caption: ComposerSubmit): void {
    this.commands.sendCaption(caption);
  }

  /**
   * The room's typists, for the row above the thread composer.
   *
   * Room's, not thread's: `m.typing` is a room-level EDU with no thread dimension, so
   * somebody typing in the main timeline shows here too. That is the protocol rather than a
   * bug, and it is why the row here does not own the announcement — the list behind it
   * already announces the same names.
   */
  protected readonly typingNames = this.timeline.typingNames;

  /**
   * Composer typing state → the room's (throttled) typing notification.
   *
   * Tagged `'thread'` so a send here cannot clear the flag while the main composer still
   * holds a draft — `m.typing` is one flag per room and both composers feed it.
   */
  onTyping(typing: boolean): void {
    this.timeline.setTyping(typing, 'thread');
  }

  onSubmit(submit: ComposerSubmit): void {
    this.commands.submit(submit);
  }

  onSendMedia(batch: Parameters<ThreadCommands['sendMedia']>[0]): void {
    this.commands.sendMedia(batch);
  }

  startEdit(row: MessageRow): void {
    this.commands.startEdit(row.id);
  }

  startReply(row: MessageRow): void {
    this.commands.startReply(row.id);
  }

  /** Pull a thread message's text into THIS panel's composer as a `>` block. */
  startQuote(row: MessageRow): void {
    this.editingId.set(null);
    this.composer()?.insertQuote(quoteBlock(row.body));
  }

  editLastOwn(): void {
    this.commands.editLastOwn();
  }

  onReact(messageId: string, key: string): void {
    this.commands.react(messageId, key);
  }

  onPollVote({
    pollId,
    answerIds,
  }: {
    pollId: string;
    answerIds: readonly string[];
  }): void {
    this.commands.voteInPoll(pollId, answerIds);
  }

  onPollEnd(pollId: string): void {
    this.commands.endPoll(pollId);
  }

  onRetry(messageId: string): void {
    this.commands.retry(messageId);
  }

  onDelete(row: MessageRow): void {
    this.commands.delete(row.id);
  }

  /**
   * Per-row caps keyed by event id, memoized so the reference is stable across
   * change-detection ticks that don't change the thread's messages — a fresh object
   * per CD would defeat the OnPush {@link MessageRowComponent} and re-render every row.
   */
  private readonly rowCapsById = computed<Map<string, MessageRowCaps>>(() => {
    this.prevRowCaps = buildRowCapsMap(
      this.rows(),
      {
        canRedactOthers: this.timeline.canRedactOthers(),
        canPin: false,
        canThread: false,
        pinnedIds: [],
      },
      this.prevRowCaps,
    );
    return this.prevRowCaps;
  });

  /** Last computed caps, for identity reuse across thread events. */
  private prevRowCaps = new Map<string, MessageRowCaps>();

  /** Per-row capabilities/state for a thread row (no pinning or nested threads). */
  rowCaps(row: MessageRow): MessageRowCaps {
    return this.rowCapsById().get(row.id) ?? THREAD_ROW_CAPS;
  }

  /** Route a single row action to its thread handler. */
  onRowAction(row: MessageRow, action: MessageRowAction): void {
    if (
      dispatchSharedRowAction(action, row, {
        roomId: this.roomId(),
        destroyRef: this.destroyRef,
        dialog: this.dialog,
        timeline: this.timeline,
        forward: this.forwardSvc,
        report: this.reportSvc,
        mediaSave: this.mediaSave,
        reactions: this.reactionsDialog,
        editHistory: this.editHistorySvc,
        react: (id, key) => this.onReact(id, key),
        quote: (r) => this.startQuote(r),
        // The thread panel routes no permalinks (its rows don't bind matrixLink either),
        // so a link followed out of the edit-history dialog just closes it.
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
      case 'retry':
        this.onRetry(row.id);
        break;
      case 'jump':
        this.jumpTo(action.id);
        break;
      // Pin/thread are not offered inside a thread (caps.canPin/canThread false).
      case 'pin':
      case 'thread':
        break;
      default: {
        // Exhaustiveness guard: a new MessageRowAction variant without a case here
        // becomes a compile error rather than a silently-dropped action.
        const unhandled: never = action;
        void unhandled;
        break;
      }
    }
  }

  /** Scroll the original message into view when its reply preview is clicked. */
  jumpTo(messageId: string): void {
    this.scrollEl()
      ?.nativeElement.querySelector(`[data-mid="${messageId}"]`)
      ?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
  }
}
