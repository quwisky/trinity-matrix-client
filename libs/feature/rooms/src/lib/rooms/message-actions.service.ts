import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { type WorkspaceRoomNavigationOrigin } from '@trinity/application/workspace';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { TrnSurfaceService } from '@trinity/components/overlay';
import {
  type ConversationHandle,
  conversationDraftKey,
  type ConversationMessageOutcome,
  ConversationRuntime,
  TimelineActionsService,
  withoutSent,
} from '@trinity/data-access/timeline';
import { DraftStoreService } from '@trinity/platform-native';
import { type Mention } from '@trinity/util/matrix';
import { latestGuard } from '@trinity/util/ui';
import type { ImagePackImage } from '@trinity/data-access/media';
import {
  EMPTY,
  Observable,
  catchError,
  defaultIfEmpty,
  finalize,
  filter,
  switchMap,
  takeUntil,
  tap,
  throwError,
  type MonoTypeOperatorFunction,
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
  batchFailureToast,
  sendMediaBatch,
  sendViaCapability,
  type BatchItem,
  type BatchOutcome,
  type BatchProgress,
} from '../shared/send-media-batch';

/** What a rejected send put back for its failed row: the text, and the reply it was aimed at. */
interface Restored {
  readonly text: string;
  readonly replyTo: string | null;
}

/**
 * Everything done to or from a message: sending, editing, deleting, reacting, replying,
 * polls, attachments, threads, pins, in-room search, and following a matrix.to link.
 *
 * `uploadProgress` lives here rather than in the store because nothing outside this cluster
 * writes it; the composer binds it through the page's alias while an attachment is in flight.
 */
@Injectable()
export class MessageActionsService {
  private readonly store = inject(RoomShellStore);
  private readonly roomSurfaces = inject(RoomSurfaceLifecycle);
  private readonly routing = inject(AccountRoutingService);
  private readonly memberActions = inject(MemberActionsService);
  private readonly status = inject(ShellStatusService);
  private readonly drafts = inject(DraftStoreService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly jumpToDateSvc = inject(JumpToDateService);
  private readonly conversations = inject(ConversationRuntime);
  private readonly timeline = this.conversations.timeline;
  private readonly compose = this.conversations.compose;
  private readonly messageCommands = this.conversations.messages;
  private readonly timelineActions = inject(TimelineActionsService);
  private readonly dialog = inject(TrnSurfaceService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly activeRoomId$ = toObservable(this.store.activeRoomId);

  /**
   * Which file of how many is uploading, and how far along, or null when idle.
   *
   * A record rather than a bare fraction because a send is a batch: without the position the
   * bar restarts from zero per file with nothing saying it is the third of five.
   */
  readonly uploadProgress = signal<BatchProgress | null>(null);

  /** Identity allocator and current owner for the progress signal shared by rooms. */
  private readonly uploads = latestGuard();
  private readonly restored = new WeakMap<
    ConversationHandle,
    Map<string, Restored>
  >();

  /**
   * Route a `matrix.to` permalink clicked in a message, in-app. A user shows a profile
   * card (from which the viewer can start a DM); a room resolves its id/alias and — if
   * we're joined — opens it, then jumps to a linked event. A room we haven't joined
   * surfaces a toast rather than navigating.
   */
  onMatrixLink(
    { target, anchor }: MatrixLinkClick,
    origin: WorkspaceRoomNavigationOrigin = 'room-action',
  ): void {
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
      this.openRoomLinkPreview(target, origin);
      return;
    }
    this.rooms
      .resolveRoomId(target.roomIdOrAlias)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (roomId) =>
          this.routing.openLinkedRoom(roomId, target.eventId, origin),
        error: () => void this.status.showError('Could not open that room.'),
      });
  }

  private openRoomLinkPreview(
    target: Extract<
      Exclude<MatrixLinkClick['target'], { kind: 'invalid' }>,
      { kind: 'room' }
    >,
    origin: WorkspaceRoomNavigationOrigin,
  ): void {
    this.dialog
      .openAndWait$<RoomLinkPreviewResult | null, RoomLinkPreviewComponent>(
        RoomLinkPreviewComponent,
        {
          autoFocus: 'first-heading',
          inputs: { target },
        },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        if (!result) return;
        if (result.membershipChanged) {
          this.routing.openConfirmedLinkedRoom(
            {
              kind: result.isSpace ? 'space' : 'room',
              roomId: result.roomId,
              accountId: result.accountId,
            },
            origin,
          );
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
          origin,
        );
      });
  }

  /**
   * Open the thread rooted at `rootEventId` (raised by a message's indicator).
   *
   * Writes the shell's one right-hand slot rather than opening a dialog; one slot makes
   * "only one at a time" structural, with no re-entrancy guards.
   */
  onOpenThread(rootEventId: string): void {
    this.roomSurfaces.transition({
      kind: 'open-thread',
      rootEventId,
    });
  }

  /** Open the threads-list panel for the active room (header "Threads" button). */
  openThreadsList(): void {
    this.roomSurfaces.transition({
      kind: 'open-threads',
    });
  }

  /**
   * A row picked in the threads list: show that thread. The list and the view never stack;
   * picking a row REPLACES the list in the slot.
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
   * The slot CLOSES on a pick: below the `members` breakpoint it is a full-width drawer over
   * the timeline, so jumping with it open scrolls a message the user cannot see and the jump
   * appears to do nothing. `pin-messages.spec.mts` asserts the close.
   *
   * CLOSE FIRST, THEN JUMP, and the order is load-bearing. The list scrolls by looking the
   * row up in the DOM, so a jump issued while the panel is still laid out measures a
   * timeline that is about to get ~480px wider — the row is scrolled to a position it no
   * longer occupies once the panel goes, and lands off screen. `afterNextRender` puts the
   * jump after the layout it depends on.
   */
  onPanelJump(eventId: string): void {
    // A pin or hit may be older than the loaded timeline; page it in first, or the
    // list has no row to scroll to. Already-loaded events resolve synchronously.
    this.timeline
      .loadEvent(eventId)
      .pipe(this.untilRoomChanges(), takeUntilDestroyed(this.destroyRef))
      .subscribe((loaded) => {
        if (loaded) {
          this.roomSurfaces.transition({ kind: 'reveal-message', eventId });
        } else {
          void this.status.showError('Could not load that message.');
        }
      });
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
      kind: 'open-pinned',
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
    const handle = this.conversations.focused();
    this.compose.setDraft(body);
    const editing = this.compose.intent().kind === 'edit';
    // Failures that predate this send, so a rejection that left no echo pairs with none of them.
    const failedBefore = new Set(
      handle?.timeline
        .messages()
        .filter((m) => m.status === 'failed')
        .map((m) => m.id),
    );
    this.compose
      .submit(mentions)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        if (
          !editing &&
          outcome.kind === 'rejected' &&
          outcome.failure === 'send-rejected'
        ) {
          this.rememberRestoredText(handle, body, failedBefore);
        }
        // A failed message keeps its echo to retry from; a failed edit's echo is gone. A second
        // Enter while one is pending, or an empty draft, tried nothing.
        if (
          editing &&
          outcome.kind === 'rejected' &&
          outcome.failure !== 'send-in-progress' &&
          outcome.failure !== 'empty-draft'
        ) {
          void this.status.showError('Could not edit the message.');
        }
      });
  }

  /**
   * A rejected send restores its text to the box and leaves a failed echo. Pair the two, so Retry
   * can tell the restored text from anything typed since, whatever the echo's body became
   * (`/me`, markdown, trimming).
   */
  private rememberRestoredText(
    handle: ConversationHandle | null,
    body: string,
    failedBefore: ReadonlySet<string>,
  ): void {
    // A send that settles after its handle retired goes back into the newer one for the room.
    const live = (handle && this.conversations.held(handle.key)) ?? handle;
    if (!live) return;
    const intent = live.compose.intent();
    // Put back in front of text typed or kept since. During an edit `draft()` is the edit's
    // body and the runtime put it into the message draft, which shows when the edit ends.
    const draft = live.compose.draft();
    if (intent.kind !== 'edit' && withoutSent(draft, body) === draft) return;
    const known = this.restored.get(live) ?? new Map<string, Restored>();
    const echo = live.timeline
      .messages()
      .filter(
        (m) => m.isOwn && m.status === 'failed' && !failedBefore.has(m.id),
      )
      .at(-1);
    if (!echo) return;
    known.set(echo.id, {
      text: body,
      replyTo: intent.kind === 'reply' ? intent.eventId : null,
    });
    this.restored.set(live, known);
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
  onPollVote({
    pollId,
    answerIds,
  }: {
    pollId: string;
    answerIds: readonly string[];
  }): void {
    this.runAction(
      this.timelineActions.votePoll(pollId, answerIds),
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
   * and the composer keeps those files staged for a retry; `runAction`'s blanket toast would
   * not say which file failed.
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
    // Pin the immutable Account-and-Room handle for the whole batch: the focused proxy
    // resolves on SUBSCRIBE, which suits a single press but not item N, subscribed minutes
    // later. Room id alone is insufficient because two Accounts can share a Matrix room id.
    const pinnedConversation = this.conversations.focused();
    let abandoned = 0;
    sendMediaBatch(
      items,
      caption,
      (_file, itemCaption, progress, media) => {
        if (
          !pinnedConversation ||
          this.conversations.focused() !== pinnedConversation
        ) {
          abandoned++;
          return throwError(() => new Error('conversation changed mid-batch'));
        }
        return sendViaCapability(
          pinnedConversation.media.send(media, itemCaption),
          progress,
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
        void this.status.showError(
          batchFailureToast(failed, abandoned, 'room'),
        );
      });
  }

  // Delete/react have no visible local echo, so a failure would otherwise be
  // silent — surface it as a toast.
  onDelete(messageId: string): void {
    const handle = this.conversations.focused();
    if (handle) this.restored.get(handle)?.delete(messageId);
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
    // The runtime's `compose` follows the focused room, which can change before a slow retry
    // settles; the handle pinned here is the failed message's own account and room.
    const handle = this.conversations.focused();
    const records = handle && this.restored.get(handle);
    const restored = records?.get(messageId);
    const compose = handle?.compose;
    // The restored text sits in the box beside the row's Retry; once the retry goes out, leaving
    // it there lets Send post it twice. Edited text is the person's and stays.
    const draftKey = handle && conversationDraftKey(handle.key);
    let cleared = false;
    const before = compose?.draft() ?? '';
    const left = restored ? withoutSent(before, restored.text) : before;
    if (
      handle &&
      compose &&
      restored &&
      draftKey &&
      compose.intent().kind !== 'edit' &&
      left !== before
    ) {
      // A reload drops the failed row, and with it the only other copy of the text, so the saved
      // drafts keep it (as for a message waiting offline) while this retry is in flight.
      this.drafts.holdWaiting(draftKey, messageId, restored.text);
      compose.setDraft(left);
      // Only the reply the failed message had; one started since is the person's.
      const intent = compose.intent();
      if (intent.kind === 'reply' && intent.eventId === restored.replyTo) {
        compose.cancelIntent();
      }
      cleared = true;
    }
    const undo = () => {
      if (!cleared || !handle || !compose || !restored) return;
      // Text typed meanwhile is the person's; the reply goes back only with the text it belongs to.
      if (compose.draft() !== left) return;
      compose.setDraft(before);
      if (restored.replyTo && compose.intent().kind === 'message') {
        handle.messages.beginReply(restored.replyTo);
      }
    };
    this.runMessageAction(
      this.messageCommands.retry(messageId).pipe(
        // A retry that ends without an answer sent nothing we know of: treat it as refused, so
        // the box is never left silently cleared.
        defaultIfEmpty<ConversationMessageOutcome, null>(null),
        tap((outcome) => {
          if (outcome?.kind === 'applied') records?.delete(messageId);
          else undo();
        }),
        filter((outcome): outcome is ConversationMessageOutcome => !!outcome),
        catchError((error: unknown) => {
          undo();
          return throwError(() => error);
        }),
        // The hold lasts while this one retry is in flight, and ends with it however it ends,
        // the page going away included (the resend still goes out). Only the tap that took it
        // lets it go.
        finalize(() => {
          if (cleared && draftKey) {
            this.drafts.releaseWaiting(draftKey, messageId);
          }
        }),
      ),
      'Could not retry the message.',
    );
  }

  onCancel(messageId: string): void {
    this.runMessageAction(
      this.messageCommands.cancel(messageId),
      'Could not cancel the message.',
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
      kind: 'open-search',
    });
  }

  /**
   * Ask for a date, then scroll the timeline to the first message on it.
   *
   * The jump reuses the lifecycle's target and revision pair as in-room search, so there is
   * one definition of "scroll the list to this event". `TimelineService.jumpToDate` has to
   * page history in until the event is actually loaded, because the list scrolls by DOM
   * lookup and an id it has never rendered is a silent no-op.
   *
   * Each unhappy outcome says its own thing: "too far back", "no messages that day" and "your
   * server cannot do this" would send people looking for a problem that is not theirs if
   * collapsed into one message.
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
        this.untilRoomChanges(),
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

  /**
   * End a jump when the person leaves its room: its outcome would be shown in the room
   * they moved to, and unsubscribing stops its paging. The room is also read on each
   * outcome, since `activeRoomId$` only emits on the next effect run.
   */
  private untilRoomChanges<T>(): MonoTypeOperatorFunction<T> {
    const roomId = this.store.activeRoomId();
    const stillThere = () => this.store.activeRoomId() === roomId;
    return (source) =>
      source.pipe(
        filter(stillThere),
        catchError((err: unknown) =>
          stillThere() ? throwError(() => err) : EMPTY,
        ),
        takeUntil(this.activeRoomId$.pipe(filter((id) => id !== roomId))),
      );
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
