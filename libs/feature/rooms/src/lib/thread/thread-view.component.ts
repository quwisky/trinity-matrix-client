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
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  filter,
  mergeMap,
  of,
  take,
  tap,
  throwError,
  type Observable,
} from 'rxjs';
import {
  sendMediaBatch,
  type BatchItem,
  type BatchOutcome,
  type BatchProgress,
} from '../shared/send-media-batch';
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
import { EmptyStateComponent } from '@trinity/components/empty-state';
import { TypingIndicatorComponent } from '../message-list/typing-indicator/typing-indicator.component';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { TrnButton } from '@trinity/components/button';
import { TrnTooltip } from '@trinity/components/tooltip';
import {
  TimelineActionsService,
  ConversationRuntime,
  isEditableMessage,
  isQuotableMessage,
  type ConversationThread,
  type ConversationThreadOutcome,
  type MessageView,
} from '@trinity/data-access/timeline';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { messagePermalink, quoteBlock } from '@trinity/util/matrix';
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
import { ReactionPickerService } from '../reaction-picker/reaction-picker.service';
import { ForwardService } from '../forward/forward.service';
import { ReportService } from '../report/report.service';
import { MessageSourceService } from '../message-source/message-source.service';
import { EditHistoryDialogService } from '../edit-history/edit-history.service';
import { ReactionsDialogService } from '../reactions-dialog/reactions-dialog.service';
import { TrnIconComponent } from '@trinity/components/icon';
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
  readOnly: false,
};

/**
 * Thread view: the root message plus its replies, with an in-thread composer.
 * Reuses the shared {@link MessageRowComponent} so a thread renders exactly like
 * the main timeline (avatars, markdown, media, reactions, the hover toolbar) and
 * the shared {@link MessageComposerComponent} so composing behaves identically
 * (Enter sends, edit/reply banners, emoji, attachments).
 *
 * Orchestration mirrors {@link SimpleMessageListComponent} but routes every action
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
    TypingIndicatorComponent,
    EmptyStateComponent,
    TrnIconComponent,
    TrnButton,
    TrnTooltip,
    MessageRowComponent,
    MessageComposerComponent,
  ],
  templateUrl: './thread-view.component.html',
  styleUrl: './thread-view.component.scss',
})
export class ThreadViewComponent implements OnDestroy {
  private readonly conversations = inject(ConversationRuntime);
  private readonly openedThread = signal<ConversationThread | null>(null);
  private readonly messageSheet = inject(MessageActionSheetService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly reactionPicker = inject(ReactionPickerService);
  private readonly forwardSvc = inject(ForwardService);
  private readonly reportSvc = inject(ReportService);
  private readonly sourceSvc = inject(MessageSourceService);
  private readonly editHistorySvc = inject(EditHistoryDialogService);
  private readonly reactionsDialog = inject(ReactionsDialogService);
  private readonly timeline = this.conversations.timeline;
  private readonly timelineActions = inject(TimelineActionsService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly roomId = input.required<string>();
  readonly rootEventId = input.required<string>();
  /** The user closed the thread. There is nothing to pick here, so no `selected`. */
  readonly dismissed = output<void>();

  /** The room's members, for the thread composer's @-mention autocomplete. */
  readonly members = computed(() => {
    return this.rooms.membersFor(this.roomId())();
  });

  /** Id of the thread message being edited, or null. */
  readonly editingId = signal<string | null>(null);
  /** Id of the thread message being replied to, or null. */
  readonly replyingToId = signal<string | null>(null);
  /** Which file of how many is uploading, and how far along, or null when idle. */
  readonly uploadProgress = signal<BatchProgress | null>(null);
  /** Identity allocator and current owner for the progress signal shared by threads. */
  private nextUploadGeneration = 0;
  private activeUploadGeneration: number | null = null;
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
      this.editingId.set(null);
      this.replyingToId.set(null);
      this.activeUploadGeneration = null;
      this.uploadProgress.set(null);
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

  /** Composer submit — routes to an edit or reply when active, else a new send. */
  /**
   * A batch caption, posted plainly into the thread. Deliberately NOT routed through
   * {@link onSubmit}: it was written before an upload that may have taken minutes, so the edit
   * or reply the user has started since is not what it belongs to.
   */
  onBatchCaption({ text, mentions }: ComposerSubmit): void {
    const thread = this.openedThread();
    if (thread) {
      this.runThreadAction(
        thread.send(text, mentions),
        'Could not send the caption.',
      );
    }
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

  onSubmit({ text, mentions }: ComposerSubmit): void {
    const editId = this.editingId();
    const replyId = this.replyingToId();
    if (editId) {
      this.editingId.set(null);
      const thread = this.openedThread();
      if (thread) {
        this.runThreadAction(
          thread.edit(editId, text, mentions),
          'Could not edit the message.',
        );
      }
    } else if (replyId) {
      this.replyingToId.set(null);
      // The reply's local echo (and its failed/retry state) surfaces the result.
      const thread = this.openedThread();
      if (thread) {
        this.runThreadAction(
          thread.reply(replyId, text, mentions),
          'Could not send the reply.',
        );
      }
    } else {
      const thread = this.openedThread();
      if (thread) {
        this.runThreadAction(
          thread.send(text, mentions),
          'Could not send the message.',
        );
      }
    }
  }

  /** The thread's half of the batch send — see `MessageActionsService.onSendMedia`. */
  onSendMedia({
    items,
    caption,
    onOutcomes,
  }: {
    items: readonly BatchItem[];
    caption: string;
    onOutcomes: (outcomes: readonly BatchOutcome[]) => void;
  }): void {
    const uploadGeneration = ++this.nextUploadGeneration;
    this.activeUploadGeneration = uploadGeneration;
    const reportProgress = (progress: BatchProgress | null): void => {
      if (uploadGeneration !== this.activeUploadGeneration) {
        return;
      }
      if (progress === null) {
        this.activeUploadGeneration = null;
      }
      this.uploadProgress.set(progress);
    };
    // Pinned for the whole batch, for the same reason as the room path: the thread is
    // resolved on SUBSCRIBE, and a batch subscribes item N long after it was pressed, so
    // opening another thread mid-batch would deliver the rest into that one.
    const pinnedThread = this.openedThread();
    let abandoned = 0;
    sendMediaBatch(
      items,
      caption,
      (_file, itemCaption, progress, media) => {
        if (!pinnedThread || this.openedThread() !== pinnedThread || !media) {
          abandoned++;
          return throwError(() => new Error('thread changed mid-batch'));
        }
        return pinnedThread.media.send(media, itemCaption).pipe(
          tap((event) => {
            if (event.kind === 'progress') progress?.(event.fraction);
          }),
          filter((event) => event.kind !== 'progress'),
          take(1),
          mergeMap((event) => {
            if (event.kind === 'sent') return of(void 0);
            if (event.failure === 'conversation-unavailable') abandoned++;
            return throwError(() => new Error(event.failure));
          }),
        );
      },
      reportProgress,
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcomes) => {
        onOutcomes(outcomes);
        const failed = outcomes.filter((outcome) => outcome.failed).length;
        if (!failed) {
          return;
        }
        void this.showError(
          abandoned
            ? `${failed} ${failed === 1 ? 'attachment was' : 'attachments were'} not sent — you left the thread before they went out.`
            : failed === 1
              ? 'One attachment could not be sent. It is still in the composer.'
              : `${failed} attachments could not be sent. They are still in the composer.`,
        );
      });
  }

  startEdit(row: MessageRow): void {
    this.replyingToId.set(null);
    this.editingId.set(row.id);
  }

  startReply(row: MessageRow): void {
    this.editingId.set(null);
    this.replyingToId.set(row.id);
  }

  /** Pull a thread message's text into THIS panel's composer as a `>` block. */
  startQuote(row: MessageRow): void {
    this.editingId.set(null);
    this.composer()?.insertQuote(quoteBlock(row.body));
  }

  /** A thread message the current user can still edit (own, confirmed, text). */
  isEditable(m: MessageView): boolean {
    return isEditableMessage(m);
  }

  /** Edit the most recent editable own message in the thread (Up-arrow shortcut). */
  editLastOwn(): void {
    const msgs = this.openedThread()?.messages() ?? [];
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

  onReact(messageId: string, key: string): void {
    const thread = this.openedThread();
    if (thread) {
      this.runThreadAction(
        thread.toggleReaction(messageId, key),
        'Could not update the reaction.',
      );
    }
  }

  /** Cast a vote on a poll in the thread (room-level m.poll.response). */
  onPollVote({ pollId, answerId }: { pollId: string; answerId: string }): void {
    this.runAction(
      this.timelineActions.votePoll(pollId, answerId),
      'Could not cast your vote.',
    );
  }

  /** Close a poll from the thread view. */
  onPollEnd(pollId: string): void {
    this.runAction(
      this.timelineActions.endPoll(pollId),
      'Could not end the poll.',
    );
  }

  /** Open the full emoji picker and, on a pick, react to the thread message with it. */
  private async pickReaction(messageId: string): Promise<void> {
    const key = await this.reactionPicker.pick();
    if (key) {
      this.onReact(messageId, key);
    }
  }

  onRetry(messageId: string): void {
    const thread = this.openedThread();
    if (thread) {
      this.runThreadAction(
        thread.retry(messageId),
        'Could not retry the message.',
      );
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
      const thread = this.openedThread();
      if (thread) {
        this.runThreadAction(
          thread.redact(row.id),
          'Could not delete the message.',
        );
      }
    }
  }

  /**
   * Per-row caps keyed by event id, memoized so the reference is stable across
   * change-detection ticks that don't change the thread's messages — a fresh object
   * per CD would defeat the OnPush {@link MessageRowComponent} and re-render every row.
   */
  private readonly rowCapsById = computed<Map<string, MessageRowCaps>>(() => {
    const canRedactOthers = this.timeline.canRedactOthers();
    const caps = new Map<string, MessageRowCaps>();
    for (const row of this.rows()) {
      caps.set(row.id, {
        editable: this.isEditable(row),
        // Own messages are always deletable; a moderator can also redact others'.
        deletable: (row.isOwn || canRedactOthers) && !row.status,
        canPin: false,
        pinned: false,
        canThread: false,
        canQuote: isQuotableMessage(row),
        readOnly: false,
      });
    }
    return caps;
  });

  /** Per-row capabilities/state for a thread row (no pinning or nested threads). */
  rowCaps(row: MessageRow): MessageRowCaps {
    return this.rowCapsById().get(row.id) ?? THREAD_ROW_CAPS;
  }

  /** Route a single row action to its thread handler. */
  onRowAction(row: MessageRow, action: MessageRowAction): void {
    switch (action.type) {
      case 'react':
        this.onReact(row.id, action.key);
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
        this.sourceSvc.open(this.roomId(), row.id);
        break;
      case 'forward':
        void this.forwardSvc.forward(this.roomId(), row.id);
        break;
      case 'report':
        void this.reportSvc.report(this.roomId(), row.id);
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
      case 'reactors':
        void this.reactionsDialog.open(row.id);
        break;
      case 'edit-history':
        // The thread panel routes no permalinks (its rows don't bind matrixLink either),
        // so a link followed out of the dialog just closes it.
        void this.editHistorySvc.openHistory(this.roomId(), row.id);
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

  /** Run a fire-and-forget thread action, surfacing a failure as a toast. */
  private runAction(action: Observable<void>, failureMessage: string): void {
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      error: () => void this.showError(failureMessage),
    });
  }

  private runThreadAction(
    action: Observable<ConversationThreadOutcome>,
    failureMessage: string,
  ): void {
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (outcome) => {
        if (outcome.kind === 'rejected') this.showError(failureMessage);
      },
      error: () => this.showError(failureMessage),
    });
  }

  private showError(message: string): void {
    this.toast.show(message, { duration: 4000, variant: 'destructive' });
  }
}
