import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { throwError, type Observable } from 'rxjs';
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
import { type SwipeDirection } from '../message-row/message-row.component';
import { EmptyStateComponent } from '@trinity/components/empty-state';
import { TypingIndicatorComponent } from '../message-list/typing-indicator/typing-indicator.component';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { HlmButton } from '@trinity/helm/button';
import { TrnTooltip } from '@trinity/components/tooltip';
import {
  ThreadsService,
  TimelineActionsService,
  TimelineService,
} from '@trinity/data-access/timeline';
import { RoomsService } from '@trinity/data-access/rooms';
import {
  isEditableMessage,
  isQuotableMessage,
  messagePermalink,
  quoteBlock,
  type MessageView,
} from '@trinity/util/matrix';
import {
  MessageRowComponent,
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
 * through {@link ThreadsService}'s thread-scoped methods, which carry the thread
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
    HlmButton,
    TrnTooltip,
    MessageRowComponent,
    MessageComposerComponent,
  ],
  templateUrl: './thread-view.component.html',
  styleUrl: './thread-view.component.scss',
})
export class ThreadViewComponent implements OnInit, OnDestroy {
  private readonly threads = inject(ThreadsService);
  private readonly messageSheet = inject(MessageActionSheetService);
  private readonly rooms = inject(RoomsService);
  private readonly reactionPicker = inject(ReactionPickerService);
  private readonly forwardSvc = inject(ForwardService);
  private readonly reportSvc = inject(ReportService);
  private readonly sourceSvc = inject(MessageSourceService);
  private readonly editHistorySvc = inject(EditHistoryDialogService);
  private readonly reactionsDialog = inject(ReactionsDialogService);
  private readonly timeline = inject(TimelineService);
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

  private readonly scrollEl = viewChild<ElementRef<HTMLElement>>('scroll');

  /** The thread's own composer, so a quote lands in it rather than the room's. */
  private readonly composer = viewChild(MessageComposerComponent);

  /** The thread's messages (root first, then replies), grouped for display. */
  readonly rows = computed<MessageRow[]>(() => {
    const msgs = this.threads.threadMessages();
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
      this.threads.threadMessages().find((m) => m.id === this.editingId())
        ?.body ?? '',
  );

  readonly replyingToName = computed(
    () =>
      this.threads.threadMessages().find((m) => m.id === this.replyingToId())
        ?.senderName ?? '',
  );

  /** Whether older thread replies remain to be paged in. */
  readonly canLoadOlder = this.threads.canPaginateThread;
  /** Whether an older-replies page is currently loading. */
  readonly loadingOlder = this.threads.loadingOlderThread;

  ngOnInit(): void {
    this.threads.openThread(this.roomId(), this.rootEventId());
  }

  ngOnDestroy(): void {
    // The sheet is a modal over this panel; leaving it standing would dispatch against a
    // thread that is no longer open.
    this.messageSheet.close(this);
    this.threads.closeThread();
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
   * A committed sideways drag on a thread reply: edit it if it can be edited, reply if not.
   *
   * Reads `rowCaps` rather than `isEditable` so the icon the reader saw and the action they
   * get are the same value — the mirror of `MessageListBase.onRowSwipe`, which this panel
   * cannot inherit because it does not extend that class.
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
   * A long press on a thread reply, on a phone or tablet.
   *
   * Present for the same reason the timeline has one, and easy to forget: this component
   * renders `trn-message-row` but does NOT extend `MessageListBase`, so it inherits none of
   * that wiring. Without this the row emitted `longPress` into nothing and — the Android
   * `contextmenu` fallback having gone with it — every action on a thread reply was
   * unreachable by touch.
   */
  onRowLongPress(row: MessageRow): void {
    this.messageSheet.open(this, this.rowCaps(row), (action) =>
      this.onRowAction(row, action),
    );
  }

  /** Announce the close; the rooms page owns the slot and empties it. */
  close(): void {
    this.dismissed.emit();
  }

  /** Page in older replies for this thread (mirrors the timeline's load-older). */
  loadOlder(): void {
    this.threads
      .paginateOpenThread()
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
    this.threads
      .sendToThread(text, mentions)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
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
      this.runAction(
        this.threads.editInThread(editId, text, mentions),
        'Could not edit the message.',
      );
    } else if (replyId) {
      this.replyingToId.set(null);
      // The reply's local echo (and its failed/retry state) surfaces the result.
      this.threads
        .replyInThread(replyId, text, mentions)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
    } else {
      this.threads
        .sendToThread(text, mentions)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
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
    // Pinned for the whole batch, for the same reason as the room path: the thread is
    // resolved on SUBSCRIBE, and a batch subscribes item N long after it was pressed, so
    // opening another thread mid-batch would deliver the rest into that one.
    const pinnedThreadId = this.threads.openThreadRootId();
    let abandoned = 0;
    sendMediaBatch(
      items,
      caption,
      (file, itemCaption, progress) => {
        if (this.threads.openThreadRootId() !== pinnedThreadId) {
          abandoned++;
          return throwError(() => new Error('thread changed mid-batch'));
        }
        return this.threads.sendMediaToThread(file, itemCaption, progress);
      },
      (progress) => this.uploadProgress.set(progress),
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
    const msgs = this.threads.threadMessages();
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
    this.runAction(
      this.threads.toggleReactionInThread(messageId, key),
      'Could not update the reaction.',
    );
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
    this.threads.retryInThread(messageId);
  }

  async onDelete(row: MessageRow): Promise<void> {
    const confirmed = await this.alert.confirm({
      header: 'Delete message',
      message: 'Delete this message? This cannot be undone.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (confirmed) {
      this.runAction(
        this.threads.redactInThread(row.id),
        'Could not delete the message.',
      );
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

  private showError(message: string): void {
    this.toast.show(message, { duration: 4000, variant: 'destructive' });
  }
}
