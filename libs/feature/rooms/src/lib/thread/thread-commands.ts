import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { throwError, type Observable } from 'rxjs';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  TimelineActionsService,
  isEditableMessage,
  type ConversationThread,
  type ConversationThreadOutcome,
} from '@trinity/data-access/timeline';
import { latestGuard } from '@trinity/util/ui';
import { confirmMessageDeletion$ } from '../message-actions/confirm-message-deletion';
import type { ComposerSubmit } from '../message-composer/message-composer.component';
import {
  batchFailureToast,
  sendMediaBatch,
  sendViaCapability,
  type BatchItem,
  type BatchOutcome,
  type BatchProgress,
} from '../shared/send-media-batch';

/**
 * The thread view's send, edit, reply, media, react and retry commands, with the local
 * editing/reply state and upload ownership they share. Provided by the thread view, so one
 * instance lives and dies with one panel. The view owns the open {@link thread} and calls
 * {@link reset} when it switches to another one.
 */
@Injectable()
export class ThreadCommands {
  private readonly timelineActions = inject(TimelineActionsService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  /** Identity allocator and current owner for the progress signal shared by threads. */
  private readonly uploads = latestGuard();

  /** The exact thread child every command is routed through; set by the view. */
  readonly thread = signal<ConversationThread | null>(null);
  /** Id of the thread message being edited, or null. */
  readonly editingId = signal<string | null>(null);
  /** Id of the thread message being replied to, or null. */
  readonly replyingToId = signal<string | null>(null);
  /** Which file of how many is uploading, and how far along, or null when idle. */
  readonly uploadProgress = signal<BatchProgress | null>(null);

  /** Forget the edit/reply in progress and orphan any upload, on a thread switch. */
  reset(): void {
    this.editingId.set(null);
    this.replyingToId.set(null);
    this.uploads.invalidate();
    this.uploadProgress.set(null);
  }

  startEdit(id: string): void {
    this.replyingToId.set(null);
    this.editingId.set(id);
  }

  startReply(id: string): void {
    this.editingId.set(null);
    this.replyingToId.set(id);
  }

  /** Edit the most recent editable own message in the thread (Up-arrow shortcut). */
  editLastOwn(): void {
    const msgs = this.thread()?.messages() ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (isEditableMessage(msgs[i])) {
        this.editingId.set(msgs[i].id);
        return;
      }
    }
  }

  /**
   * A batch caption, posted plainly into the thread. Deliberately NOT routed through
   * {@link submit}: it was written before an upload that may have taken minutes, so the edit
   * or reply the user has started since is not what it belongs to.
   */
  sendCaption({ text, mentions }: ComposerSubmit): void {
    this.run((t) => t.send(text, mentions), 'Could not send the caption.');
  }

  /** Composer submit — routes to an edit or reply when active, else a new send. */
  submit({ text, mentions }: ComposerSubmit): void {
    const editId = this.editingId();
    const replyId = this.replyingToId();
    if (editId) {
      this.editingId.set(null);
      this.run(
        (t) => t.edit(editId, text, mentions),
        'Could not edit the message.',
      );
    } else if (replyId) {
      this.replyingToId.set(null);
      // The reply's local echo (and its failed/retry state) surfaces the result.
      this.run(
        (t) => t.reply(replyId, text, mentions),
        'Could not send the reply.',
      );
    } else {
      this.run((t) => t.send(text, mentions), 'Could not send the message.');
    }
  }

  /** The thread's half of the batch send — see `MessageActionsService.onSendMedia`. */
  sendMedia({
    items,
    caption,
    onOutcomes,
  }: {
    items: readonly BatchItem[];
    caption: string;
    onOutcomes: (outcomes: readonly BatchOutcome[]) => void;
  }): void {
    const token = this.uploads.next();
    const reportProgress = (progress: BatchProgress | null): void => {
      if (!this.uploads.isCurrent(token)) {
        return;
      }
      if (progress === null) {
        this.uploads.invalidate();
      }
      this.uploadProgress.set(progress);
    };
    // Pinned for the whole batch, for the same reason as the room path: the thread is
    // resolved on SUBSCRIBE, and a batch subscribes item N long after it was pressed, so
    // opening another thread mid-batch would deliver the rest into that one.
    const pinnedThread = this.thread();
    let abandoned = 0;
    sendMediaBatch(
      items,
      caption,
      (_file, itemCaption, progress, media) => {
        if (!pinnedThread || this.thread() !== pinnedThread) {
          abandoned++;
          return throwError(() => new Error('thread changed mid-batch'));
        }
        return sendViaCapability(
          pinnedThread.media.send(media, itemCaption),
          progress,
          (failure) => {
            if (failure === 'conversation-unavailable') abandoned++;
          },
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
        this.showError(batchFailureToast(failed, abandoned, 'thread'));
      });
  }

  react(messageId: string, key: string): void {
    this.run(
      (t) => t.toggleReaction(messageId, key),
      'Could not update the reaction.',
    );
  }

  /** Cast a vote on a poll in the thread (room-level m.poll.response). */
  voteInPoll(pollId: string, answerIds: readonly string[]): void {
    this.runAction(
      this.timelineActions.votePoll(pollId, answerIds),
      'Could not cast your vote.',
    );
  }

  /** Close a poll from the thread view. */
  endPoll(pollId: string): void {
    this.runAction(
      this.timelineActions.endPoll(pollId),
      'Could not end the poll.',
    );
  }

  retry(messageId: string): void {
    this.run((t) => t.retry(messageId), 'Could not retry the message.');
  }

  delete(messageId: string): void {
    confirmMessageDeletion$(this.alert)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() =>
        this.run((t) => t.redact(messageId), 'Could not delete the message.'),
      );
  }

  /** Run a fire-and-forget room action, surfacing a failure as a toast. */
  private runAction(action: Observable<void>, failureMessage: string): void {
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      error: () => this.showError(failureMessage),
    });
  }

  /** Run a command on the open thread (resolved now), surfacing a rejection as a toast. */
  private run(
    command: (
      thread: ConversationThread,
    ) => Observable<ConversationThreadOutcome>,
    failureMessage: string,
  ): void {
    const thread = this.thread();
    if (!thread) return;
    command(thread)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (outcome) => {
          if (outcome.kind === 'rejected') this.showError(failureMessage);
        },
        error: () => this.showError(failureMessage),
      });
  }

  private showError(message: string): void {
    this.toast.show(message, { duration: 4000, variant: 'danger' });
  }
}
