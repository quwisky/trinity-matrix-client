import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { PinnedMessagesService } from '@trinity/data-access/pinned';
import { RoomsService } from '@trinity/data-access/rooms';
import { TimelineService } from '@trinity/data-access/timeline';
import { type Mention, type MatrixLinkTarget } from '@trinity/util/matrix';
import { Observable, finalize } from 'rxjs';
import { ThreadPanelService } from '../thread/thread-panel.service';
import { PinnedPanelService } from '../pinned/pinned-panel.service';
import { MessageSearchService } from '../message-search/message-search.service';
import { RoomShellStore } from './room-shell-store';
import { AccountRoutingService } from './account-routing.service';
import { MemberActionsService } from './member-actions.service';
import { ShellStatusService } from './shell-status.service';

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
  private readonly routing = inject(AccountRoutingService);
  private readonly memberActions = inject(MemberActionsService);
  private readonly status = inject(ShellStatusService);
  private readonly rooms = inject(RoomsService);
  private readonly timeline = inject(TimelineService);
  private readonly pinned = inject(PinnedMessagesService);
  private readonly threadPanel = inject(ThreadPanelService);
  private readonly pinnedPanel = inject(PinnedPanelService);
  private readonly messageSearch = inject(MessageSearchService);
  private readonly destroyRef = inject(DestroyRef);

  /** Attachment upload fraction in [0, 1] while a send is uploading, else null. */
  readonly uploadProgress = signal<number | null>(null);

  /**
   * Route a `matrix.to` permalink clicked in a message, in-app. A user shows a profile
   * card (from which the viewer can start a DM); a room resolves its id/alias and — if
   * we're joined — opens it, then jumps to a linked event. A room we haven't joined
   * surfaces a toast rather than navigating.
   */
  onMatrixLink(target: MatrixLinkTarget): void {
    if (target.kind === 'user') {
      void this.memberActions.openUserCard(target.userId);
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

  /** Open the thread rooted at `rootEventId` (raised by a message's indicator). */
  onOpenThread(rootEventId: string): void {
    const roomId = this.store.activeRoomId();
    if (roomId) {
      void this.threadPanel.open(roomId, rootEventId);
    }
  }

  /** Open the threads-list panel for the active room (header "Threads" button). */
  openThreadsList(): void {
    const roomId = this.store.activeRoomId();
    if (roomId) {
      void this.threadPanel.openList(roomId);
    }
  }

  /** Pin or unpin a message from its overflow menu, resolving which by current state. */
  onTogglePin(eventId: string): void {
    const pinning = !this.pinned.isPinned(eventId);
    const action = pinning
      ? this.pinned.pin(eventId)
      : this.pinned.unpin(eventId);
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () =>
        this.status.showSuccess(
          pinning ? 'Message pinned.' : 'Message unpinned.',
        ),
      error: () =>
        void this.status.showError(
          pinning
            ? 'Could not pin the message.'
            : 'Could not unpin the message.',
        ),
    });
  }

  /**
   * Open the pinned-messages panel for the active room and, on a chosen row, jump the
   * timeline to that event. Bumping jumpRequest guarantees the list's jump effect
   * re-fires even when the same message is picked again (as in-room search does).
   */
  async openPinnedPanel(): Promise<void> {
    const eventId = await this.pinnedPanel.openPanel();
    if (!eventId) {
      return; // cancelled / already open / just closed
    }
    this.store.messageSearchTarget.set(eventId);
    this.store.jumpRequest.update((n) => n + 1);
  }

  loadOlder(): void {
    this.timeline
      .loadOlder()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  onSend({ body, mentions }: { body: string; mentions: Mention[] }): void {
    // The local echo (and its failed/retry state) surfaces the result.
    this.timeline
      .send(body, mentions)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Composer typing state → a (throttled) Matrix typing notification for the room. */
  onTyping(typing: boolean): void {
    this.timeline.setTyping(typing);
  }

  /** Cast a vote on a poll (m.poll.response). */
  onPollVote({ pollId, answerId }: { pollId: string; answerId: string }): void {
    this.runAction(
      this.timeline.votePoll(pollId, answerId),
      'Could not cast your vote.',
    );
  }

  /** Close a poll (m.poll.end). */
  onPollEnd(pollId: string): void {
    this.runAction(this.timeline.endPoll(pollId), 'Could not end the poll.');
  }

  onSendMedia({ file, caption }: { file: File; caption: string }): void {
    // The upload phase has no echo, so drive a determinate progress bar from the
    // upload fraction and surface a failure as a toast. Once the event is sent the
    // SDK echo + retry path takes over (like onSend). finalize() clears the bar on
    // success, error, or unsubscribe — runAction has no such hook, so subscribe here.
    this.uploadProgress.set(0);
    this.timeline
      .sendMedia(file, caption, (fraction) => this.uploadProgress.set(fraction))
      .pipe(
        finalize(() => this.uploadProgress.set(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        error: () =>
          void this.status.showError('Could not upload the attachment.'),
      });
  }

  // Edit/delete/react have no visible local echo, so a failure would otherwise be
  // silent — surface it as a toast. (Send/reply produce an echo with a retry.)
  onEdit(edit: { id: string; body: string; mentions: Mention[] }): void {
    this.runAction(
      this.timeline.edit(edit.id, edit.body, edit.mentions),
      'Could not edit the message.',
    );
  }

  onDelete(messageId: string): void {
    this.runAction(
      this.timeline.redact(messageId),
      'Could not delete the message.',
    );
  }

  onReact(reaction: { id: string; key: string }): void {
    this.runAction(
      this.timeline.toggleReaction(reaction.id, reaction.key),
      'Could not update the reaction.',
    );
  }

  onReply(reply: { id: string; body: string; mentions: Mention[] }): void {
    this.timeline
      .reply(reply.id, reply.body, reply.mentions)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Run a fire-and-forget timeline action, surfacing a failure as a toast. */
  runAction(action: Observable<void>, failureMessage: string): void {
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      error: () => void this.status.showError(failureMessage),
    });
  }

  /**
   * Open in-room message search for the active room and, on a chosen hit, jump the
   * timeline to that event. Bumping jumpRequest guarantees the list's jump effect
   * re-fires even when the same message is picked again.
   */
  async openMessageSearch(): Promise<void> {
    const roomId = this.store.activeRoomId();
    if (!roomId) {
      return;
    }
    const eventId = await this.messageSearch.search(roomId);
    if (!eventId) {
      return; // cancelled / already open
    }
    this.store.messageSearchTarget.set(eventId);
    this.store.jumpRequest.update((n) => n + 1);
  }
}
