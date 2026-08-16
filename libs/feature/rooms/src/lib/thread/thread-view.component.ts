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
import { finalize, type Observable } from 'rxjs';
import {
  TrnDialogRef,
  TrnAlertService,
  TrnToastService,
} from '@trinity/components/overlay';
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
 * relation so sends/edits/replies stay in the thread. Presented via
 * {@link ThreadPanelService} as a full-height, right-aligned {@link TrnDialogService}
 * side panel (full-screen on mobile); `roomId`/`rootEventId` arrive as signal inputs.
 */
@Component({
  selector: 'trn-thread-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
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
  private readonly rooms = inject(RoomsService);
  private readonly reactionPicker = inject(ReactionPickerService);
  private readonly forwardSvc = inject(ForwardService);
  private readonly reportSvc = inject(ReportService);
  private readonly sourceSvc = inject(MessageSourceService);
  private readonly editHistorySvc = inject(EditHistoryDialogService);
  private readonly reactionsDialog = inject(ReactionsDialogService);
  private readonly timeline = inject(TimelineService);
  private readonly timelineActions = inject(TimelineActionsService);
  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly roomId = input.required<string>();
  readonly rootEventId = input.required<string>();
  /** Notifies any @Output-bound host that the view closed (for symmetry/tests). */
  readonly closed = output<void>();

  /** The room's members, for the thread composer's @-mention autocomplete. */
  readonly members = computed(() => {
    return this.rooms.membersFor(this.roomId())();
  });

  /** Id of the thread message being edited, or null. */
  readonly editingId = signal<string | null>(null);
  /** Id of the thread message being replied to, or null. */
  readonly replyingToId = signal<string | null>(null);
  /** Attachment upload fraction in [0, 1] while a send uploads, else null (idle). */
  readonly uploadProgress = signal<number | null>(null);

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
    this.threads.closeThread();
  }

  /** Close the host dialog (Output bindings aren't wired on dialog components). */
  close(): void {
    this.closed.emit();
    this.dialogRef.close();
  }

  /** Page in older replies for this thread (mirrors the timeline's load-older). */
  loadOlder(): void {
    this.threads
      .paginateOpenThread()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Composer submit — routes to an edit or reply when active, else a new send. */
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

  onSendMedia({ file, caption }: { file: File; caption: string }): void {
    this.uploadProgress.set(0);
    this.threads
      .sendMediaToThread(file, caption, (fraction) =>
        this.uploadProgress.set(fraction),
      )
      .pipe(
        finalize(() => this.uploadProgress.set(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        error: () => void this.showError('Could not upload the attachment.'),
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
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
