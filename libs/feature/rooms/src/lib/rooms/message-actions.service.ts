import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { TrnDialogService } from '@trinity/components/overlay';
import { isMobileOs } from '@trinity/platform-native';
import {
  type ConversationMessageOutcome,
  ConversationRuntime,
  TimelineActionsService,
} from '@trinity/data-access/timeline';
import { type Mention } from '@trinity/util/matrix';
import type { ImagePackImage } from '@trinity/data-access/media';
import {
  Observable,
  filter,
  mergeMap,
  of,
  switchMap,
  take,
  tap,
  throwError,
} from 'rxjs';
import { JumpToDateService } from '../jump-to-date/jump-to-date.service';
import { type MatrixLinkClick } from '../matrix-link/matrix-link.directive';
import {
  RoomLinkPreviewComponent,
  type RoomLinkPreviewResult,
} from '../room-link-preview/room-link-preview.component';
import { RoomShellStore } from './room-shell-store';
import { AccountRoutingService } from './account-routing.service';
import { MemberActionsService } from './member-actions.service';
import { ShellStatusService } from './shell-status.service';
import { RoomSurfaceLifecycle } from './room-surface-lifecycle';
import {
  sendMediaBatch,
  type BatchItem,
  type BatchOutcome,
  type BatchProgress,
} from '../shared/send-media-batch';

/**
 * Everything done to or from a message: sending, editing, deleting, reacting, replying,
 * polls, attachments, threads, pins, in-room search, and following a matrix.to link.
 *
 * `uploadProgress` lives here rather than in the store because nothing outside this
 * cluster writes it — the composer binds it through the page's alias while an attachment
 * is in flight.
 */
@Injectable()
export class MessageActionsService {
  private readonly store = inject(RoomShellStore);
  private readonly roomSurfaces = inject(RoomSurfaceLifecycle);
  private readonly routing = inject(AccountRoutingService);
  private readonly memberActions = inject(MemberActionsService);
  private readonly status = inject(ShellStatusService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly jumpToDateSvc = inject(JumpToDateService);
  private readonly conversations = inject(ConversationRuntime);
  private readonly timeline = this.conversations.timeline;
  private readonly compose = this.conversations.compose;
  private readonly messageCommands = this.conversations.messages;
  private readonly timelineActions = inject(TimelineActionsService);
  private readonly dialog = inject(TrnDialogService);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * Which file of how many is uploading, and how far along, or null when idle.
   *
   * A record rather than a bare fraction because a send is now a batch: without the position
   * the bar restarts from zero per file with nothing saying it is the third of five.
   */
  readonly uploadProgress = signal<BatchProgress | null>(null);

  /** Identity allocator and current owner for the progress signal shared by rooms. */
  private nextUploadGeneration = 0;
  private activeUploadGeneration: number | null = null;

  /**
   * Route a `matrix.to` permalink clicked in a message, in-app. A user shows a profile
   * card (from which the viewer can start a DM); a room resolves its id/alias and — if
   * we're joined — opens it, then jumps to a linked event. A room we haven't joined
   * surfaces a toast rather than navigating.
   */
  onMatrixLink({ target, anchor }: MatrixLinkClick): void {
    if (target.kind === 'invalid') {
      void this.status.showError(
        'That Matrix link is malformed or unsupported.',
      );
      return;
    }
    if (target.kind === 'user') {
      // The anchor travels through so the card is pinned to the mention that was clicked
      // rather than centred over the conversation it is about.
      this.memberActions.openUserCard(target.userId, anchor);
      return;
    }
    if (!target.eventId) {
      this.openRoomLinkPreview(target);
      return;
    }
    this.rooms
      .resolveRoomId(target.roomIdOrAlias)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (roomId) => this.routing.openLinkedRoom(roomId, target.eventId),
        error: () => void this.status.showError('Could not open that room.'),
      });
  }

  private openRoomLinkPreview(
    target: Extract<
      Exclude<MatrixLinkClick['target'], { kind: 'invalid' }>,
      { kind: 'room' }
    >,
  ): void {
    const mobile = isMobileOs();
    this.dialog
      .openAndWait$<RoomLinkPreviewResult | null, RoomLinkPreviewComponent>(
        RoomLinkPreviewComponent,
        {
          ariaLabel: 'Room information',
          autoFocus: 'first-heading',
          placement: mobile ? 'bottom' : 'center',
          inputs: { target, sheet: mobile },
        },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        if (!result) return;
        if (result.membershipChanged) {
          this.routing.openConfirmedLinkedRoom({
            kind: result.isSpace ? 'space' : 'room',
            roomId: result.roomId,
            accountId: result.accountId,
          });
          return;
        }
        if (result.isSpace) {
          this.routing.onSelectSpaceRow({
            spaceId: result.roomId,
            accountId: result.accountId,
          });
          return;
        }
        this.routing.onSelectRoomSelection(
          { roomId: result.roomId, accountId: result.accountId },
          'room-action',
        );
      });
  }

  /**
   * Open the thread rooted at `rootEventId` (raised by a message's indicator).
   *
   * Writes the shell's one right-hand slot rather than opening a dialog. The three
   * services that used to wrap `TrnDialogService` for these surfaces are gone: with the
   * presentation decided by the slot, their whole remaining job was indirection, and each
   * carried a re-entrancy guard that only existed because two dialogs could stack. One
   * slot makes "only one at a time" structural — there is one value.
   */
  onOpenThread(rootEventId: string): void {
    this.roomSurfaces.transition({
      kind: 'open',
      surface: { kind: 'thread', rootEventId },
    });
  }

  /** Open the threads-list panel for the active room (header "Threads" button). */
  openThreadsList(): void {
    this.roomSurfaces.transition({
      kind: 'open',
      surface: { kind: 'threads' },
    });
  }

  /**
   * A row picked in the threads list: show that thread.
   *
   * The list and the view never stack — picking a row REPLACES the list in the slot, which
   * is what the old `openAndWait`-then-open dance achieved by closing one dialog before
   * opening the next.
   */
  onThreadPicked(rootEventId: string): void {
    this.onOpenThread(rootEventId);
  }

  /**
   * A row picked in the pinned panel or in search: jump the timeline to it.
   *
   * Bumping the lifecycle's jump revision guarantees the list effect re-fires when the same
   * message is picked twice — the target alone would not change, so nothing would happen.
   *
   * The slot CLOSES on a pick, which is what the dialog it replaced did. Leaving it open was
   * tried and is wrong: below the `members` breakpoint the slot is a full-width drawer over
   * the timeline, so jumping with it open scrolls a message the user cannot see — the jump
   * appears to do nothing. Closing is also what `pin-messages.spec.mts` has always asserted.
   *
   * CLOSE FIRST, THEN JUMP, and the order is load-bearing. The list scrolls by looking the
   * row up in the DOM, so a jump issued while the panel is still laid out measures a
   * timeline that is about to get ~480px wider — the row is scrolled to a position it no
   * longer occupies once the panel goes, and lands off screen with only its flash to show
   * for it. `afterNextRender` puts the jump after the layout it depends on. The dialog got
   * this for free: `openAndWait` resolved a microtask AFTER the overlay was torn down.
   */
  onPanelJump(eventId: string): void {
    this.roomSurfaces.transition({ kind: 'reveal-message', eventId });
  }

  /** Pin or unpin a message from its overflow menu, resolving which by current state. */
  onTogglePin(eventId: string): void {
    const pinning = !this.conversations.pins.isPinned(eventId);
    const action = pinning
      ? this.conversations.pins.pin(eventId)
      : this.conversations.pins.unpin(eventId);
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (outcome) => {
        if (outcome.kind === 'applied') {
          this.status.showSuccess(
            pinning ? 'Message pinned.' : 'Message unpinned.',
          );
        } else {
          void this.showPinFailure(pinning);
        }
      },
      error: () => void this.showPinFailure(pinning),
    });
  }

  private showPinFailure(pinning: boolean): void {
    void this.status.showError(
      pinning ? 'Could not pin the message.' : 'Could not unpin the message.',
    );
  }

  /** Show the pinned-messages panel in the slot; rows arrive back via {@link onPanelJump}. */
  openPinnedPanel(): void {
    this.roomSurfaces.transition({
      kind: 'open',
      surface: { kind: 'pinned' },
    });
  }

  loadOlder(): void {
    this.timeline
      .loadOlder()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  onSend({ body, mentions }: { body: string; mentions: Mention[] }): void {
    // The runtime clears durable intent only after the SDK accepts the event and exposes
    // its authoritative local echo. Rejections and cancellation restore it for retry.
    this.compose.setDraft(body);
    this.compose
      .submit(mentions)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  onSendSticker(sticker: ImagePackImage): void {
    if (this.timeline.roomEncrypted) {
      this.status.showWarning(
        'Sticker images are public homeserver media, even in encrypted rooms.',
      );
    }
    this.runAction(
      this.timelineActions.sendSticker(sticker),
      'Could not send the sticker.',
    );
  }

  /** Cast a vote on a poll (m.poll.response). */
  onPollVote({ pollId, answerId }: { pollId: string; answerId: string }): void {
    this.runAction(
      this.timelineActions.votePoll(pollId, answerId),
      'Could not cast your vote.',
    );
  }

  /** Close a poll (m.poll.end). */
  onPollEnd(pollId: string): void {
    this.runAction(
      this.timelineActions.endPoll(pollId),
      'Could not end the poll.',
    );
  }

  /**
   * Send staged attachments as N events, one at a time and in order.
   *
   * The upload phase has no echo, so the batch drives a determinate bar from each file's
   * fraction; once an event is sent the SDK's echo + retry path takes over (like `onSend`).
   * `sendMediaBatch` resolves rather than throwing, so per-item failures arrive as outcomes
   * and the composer keeps those files staged for a retry — nothing is lost by a bad third
   * file, and `runAction`'s blanket toast would have told the user nothing about which.
   */
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
    // Pin the immutable Account-and-Room handle for the whole batch. The focused proxy resolves
    // on SUBSCRIBE — right for a single press, but item N subscribes minutes later. Room id alone
    // is insufficient because two Accounts can share the same Matrix room id.
    const pinnedConversation = this.conversations.focused();
    const pinnedRoomId = this.timeline.openRoomId;
    let abandoned = 0;
    sendMediaBatch(
      items,
      caption,
      (file, itemCaption, progress, media) => {
        if (!media) {
          // Transitional compatibility for pre-pipeline callers. Production composer
          // batches always carry `media`; the File path disappears with thread migration #309.
          if (this.timeline.openRoomId !== pinnedRoomId) {
            abandoned++;
            return throwError(() => new Error('room changed mid-batch'));
          }
          return this.timelineActions.sendMedia(file, itemCaption, progress);
        }
        if (
          !pinnedConversation ||
          this.conversations.focused() !== pinnedConversation
        ) {
          abandoned++;
          return throwError(() => new Error('conversation changed mid-batch'));
        }
        return pinnedConversation.media.send(media, itemCaption).pipe(
          tap((event) => {
            if (event.kind === 'progress') progress?.(event.fraction);
          }),
          filter((event) => event.kind !== 'progress'),
          take(1),
          mergeMap((event) =>
            event.kind === 'sent'
              ? of(void 0)
              : throwError(() => new Error(event.failure)),
          ),
        );
      },
      reportProgress,
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      // `onOutcomes` also releases the composer's send latch, and it rides the value rather
      // than a `finalize` because it carries which items failed. The one path that skips it
      // is unsubscribe — and this service belongs to the page the composer lives in, so
      // there is no composer left to strand when that happens.
      .subscribe((outcomes) => {
        onOutcomes(outcomes);
        const failed = outcomes.filter((outcome) => outcome.failed).length;
        if (!failed) {
          return;
        }
        // Two different fates, and they are counted separately rather than lumped under
        // whichever happened to occur: the composer drops its staging on a room change, so
        // "still in the composer" is true for an upload that failed and false for one
        // abandoned by leaving. Blaming a network failure on the room switch would send the
        // user looking for a file that is not there.
        const upload = failed - abandoned;
        void this.status.showError(
          abandoned && upload
            ? `${abandoned} ${plural(abandoned, 'attachment', 'attachments')} not sent — you left the room before they went out — and ${upload} could not be uploaded.`
            : abandoned
              ? `${abandoned} ${plural(abandoned, 'attachment was', 'attachments were')} not sent — you left the room before they went out.`
              : upload === 1
                ? 'One attachment could not be sent. It is still in the composer.'
                : `${upload} attachments could not be sent. They are still in the composer.`,
        );
      });
  }

  // Delete/react have no visible local echo, so a failure would otherwise be
  // silent — surface it as a toast.
  onDelete(messageId: string): void {
    this.runMessageAction(
      this.messageCommands.redact(messageId),
      'Could not delete the message.',
    );
  }

  onReact(reaction: { id: string; key: string }): void {
    this.runMessageAction(
      this.messageCommands.toggleReaction(reaction.id, reaction.key),
      'Could not update the reaction.',
    );
  }

  onRetry(messageId: string): void {
    this.runMessageAction(
      this.messageCommands.retry(messageId),
      'Could not retry the message.',
    );
  }

  /** Run a fire-and-forget timeline action, surfacing a failure as a toast. */
  private runAction(action: Observable<void>, failureMessage: string): void {
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      error: () => void this.status.showError(failureMessage),
    });
  }

  private runMessageAction(
    action: Observable<ConversationMessageOutcome>,
    failureMessage: string,
  ): void {
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (outcome) => {
        if (outcome.kind === 'rejected') {
          void this.status.showError(failureMessage);
        }
      },
      error: () => void this.status.showError(failureMessage),
    });
  }

  /**
   * Show in-room message search in the slot; hits arrive back via {@link onPanelJump}.
   */
  openMessageSearch(): void {
    this.roomSurfaces.transition({
      kind: 'open',
      surface: { kind: 'search' },
    });
  }

  /**
   * Ask for a date, then scroll the timeline to the first message on it.
   *
   * The jump reuses the lifecycle's target and revision pair as in-room search, so there is
   * one definition of "scroll the list to this event". What is different is
   * everything before that: `TimelineService.jumpToDate` has to page history in until the
   * event is actually loaded, because the list scrolls by DOM lookup and an id it has
   * never rendered is a silent no-op.
   *
   * Each unhappy outcome says its own thing. "Too far back" is not "no messages that day",
   * and neither is "your server cannot do this" — collapsing them into one message would
   * send people looking for a problem that is not theirs.
   */
  jumpToDate(): void {
    if (!this.store.activeRoomId()) {
      return;
    }
    this.jumpToDateSvc
      .pick$()
      .pipe(
        filter((at): at is number => at !== null),
        switchMap((at) => this.timeline.jumpToDate(at)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (result) => {
          if (result.kind === 'found') {
            this.roomSurfaces.transition({
              kind: 'reveal-message',
              eventId: result.eventId,
            });
            return;
          }
          void this.status.showError(JUMP_FAILURE_MESSAGE[result.kind]);
        },
        error: () => void this.status.showError('Could not jump to that date.'),
      });
  }
}

/** What to say for each outcome that is not a successful jump. */
const JUMP_FAILURE_MESSAGE = {
  'too-far':
    'That date is further back than Trinity can load here. Scroll up to load more history first.',
  'no-event': 'No messages on or after that date.',
  unsupported: 'This homeserver cannot jump to a date.',
  failed: 'Could not reach your homeserver. Try that date again.',
} as const;

/** Pick the singular or plural wording for a count. */
function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
