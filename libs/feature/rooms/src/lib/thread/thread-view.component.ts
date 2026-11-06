import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { POST_UNAVAILABLE_COPY } from '../message-composer/post-unavailable-copy';
import { ThreadCommands } from './thread-commands';
import { SidePanelHeaderComponent } from '../side-panel/side-panel-header.component';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  MessageGestureSettingsService,
  isMobileOs,
} from '@trinity/platform-native';
import { type SwipeDirection } from '../message-row/message-row.component';
import { EmptyStateComponent } from '@trinity/components/generic-content';
import { TypingIndicatorComponent } from '../message-list/typing-indicator/typing-indicator.component';
import {
  TrnOverlaySurfaceDirective,
  releaseInputTargetOnDestroy,
} from '@trinity/components/overlay';
import {
  ConversationRuntime,
  threadDraftKey,
} from '@trinity/data-access/timeline';
import { RoomMembersService } from '@trinity/data-access/room-administration';
import {
  MessageComposerComponent,
  type ComposerSubmit,
} from '../message-composer/message-composer.component';
import { MessageListComponent } from '../message-list/message-list.component';
import { MESSAGE_LIST_COMMANDS } from '../message-list/message-list-commands';
import { BELOW_MEMBERS_QUERY, mediaQuerySignal } from '@trinity/util/ui';

/**
 * Thread view: the root message plus its replies, rendered by the room timeline's
 * {@link MessageListComponent}, with an in-thread composer below it.
 *
 * The list's edit/reply state is {@link ThreadCommands} (through `MESSAGE_LIST_COMMANDS`), and
 * every command goes through the exact {@link ConversationThread} child, whose commands carry
 * the thread relation so sends/edits/replies stay in the thread. It closes nothing itself: it
 * announces {@link ThreadViewComponent.dismissed} and the rooms page empties the slot.
 */
@Component({
  selector: 'trn-thread-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    SidePanelHeaderComponent,
    TypingIndicatorComponent,
    EmptyStateComponent,
    MessageListComponent,
    MessageComposerComponent,
    TrnOverlaySurfaceDirective,
  ],
  providers: [
    ThreadCommands,
    { provide: MESSAGE_LIST_COMMANDS, useExisting: ThreadCommands },
  ],
  templateUrl: './thread-view.component.html',
  styleUrl: './thread-view.component.scss',
})
export class ThreadViewComponent implements OnDestroy {
  private readonly conversations = inject(ConversationRuntime);
  private readonly commands = inject(ThreadCommands);
  private readonly openedThread = this.commands.thread;
  private readonly roomMembers = inject(RoomMembersService);
  private readonly timeline = this.conversations.timeline;
  protected readonly postUnavailableReason = computed(() =>
    this.timeline.canSendMessages() ? null : POST_UNAVAILABLE_COPY,
  );
  protected readonly canRedactOthers = this.timeline.canRedactOthers;
  private readonly destroyRef = inject(DestroyRef);

  readonly roomId = input.required<string>();
  readonly accountId = input<string | null>(null);
  /** Shown under the title so a thread page says which room it belongs to. */
  readonly roomName = input('');
  readonly rootEventId = input.required<string>();
  /** A message to scroll to once it is in the thread, paging older replies to reach it. */
  readonly revealEventId = input<string | null>(null);
  /** A new value asks for the reveal again, as when the same message is opened a second time. */
  readonly revealRequest = input<unknown>(null);
  readonly revealFailed = output<void>();
  /**
   * Whether the typing row above the composer announces. Only when this panel is a page over
   * an inert room: otherwise the room's list announces the same room-wide names.
   */
  readonly announceTyping = input(false);
  /** Its root is still loading: show the panel's loading state and open nothing yet. */
  readonly loading = input(false);
  /** The user closed the thread. There is nothing to pick here, so no `selected`. */
  readonly dismissed = output<void>();

  /**
   * What the thread composer keys its draft by. Shared with a session handover's unsent
   * thread replies, which go back under the same key.
   */
  readonly draftKey = computed(() => threadDraftKey(this.rootEventId()));

  /** The room's members, for the thread composer's @-mention autocomplete. */
  readonly members = computed(() => {
    return this.roomMembers.membersFor(this.roomId())();
  });

  readonly editingId = this.commands.editingId;
  readonly editSending = this.commands.sending;
  readonly replyingToId = this.commands.replyingToId;
  readonly uploadProgress = this.commands.uploadProgress;
  private revealedEventId: string | null = null;
  private revealedRequest: unknown = null;
  /** The reveal already reported missing, so a later rows change does not report it again. */
  private revealMissing: string | null = null;
  private readonly threadBinding = effect(() => {
    const loading = this.loading();
    const roomId = this.roomId();
    const rootEventId = this.rootEventId();
    const current = this.openedThread();
    if (
      !loading &&
      current?.key.roomId === roomId &&
      current.key.rootEventId === rootEventId
    ) {
      return;
    }
    if (current) {
      current.release();
      this.commands.reset();
      this.timeline.setTyping(false, 'thread');
    }
    this.openedThread.set(
      loading ? null : this.conversations.threads.forRoot(rootEventId),
    );
  });

  /** The thread's own composer, so a quote lands in it rather than the room's. */
  private readonly composer = viewChild(MessageComposerComponent);

  /** Hands the list's quote action to this panel's composer. */
  protected readonly quoteIntoComposer = (text: string): void =>
    this.composer()?.insertQuote(text);

  /** The thread's messages, root first, then replies. */
  readonly messages = computed(() => this.openedThread()?.messages() ?? []);

  /**
   * The oldest loaded reply, the list's backfill marker. Not `messages()[0]`: the root always
   * leads, so the marker would never move and the list would stop filling after one page.
   */
  protected readonly oldestReplyId = computed(
    () =>
      this.messages().find((message) => message.id !== this.rootEventId())
        ?.id ?? null,
  );

  readonly editingDraft = computed(
    () => this.messages().find((m) => m.id === this.editingId())?.body ?? '',
  );

  readonly replyingToName = computed(
    () =>
      this.messages().find((m) => m.id === this.replyingToId())?.senderName ??
      '',
  );

  /** Whether older thread replies remain to be paged in. */
  readonly canLoadOlder = computed(
    () => this.openedThread()?.canLoadOlder() ?? false,
  );
  /** Whether an older-replies page is currently loading. */
  readonly loadingOlder = computed(
    () => this.openedThread()?.loadingOlder() ?? false,
  );

  /** The list's jump request; the nonce lets the same message be revealed again. */
  protected readonly jumpToId = signal<string | null>(null);
  protected readonly jumpToNonce = signal(0);

  private readonly revealBinding = effect(() => {
    const id = this.revealEventId();
    const request = this.revealRequest();
    if (request !== this.revealedRequest) {
      this.revealedRequest = request;
      this.revealedEventId = null;
      this.revealMissing = null;
    }
    if (!id || id === this.revealedEventId) return;
    if (this.messages().some((message) => message.id === id)) {
      this.revealedEventId = id;
      untracked(() => {
        this.jumpToId.set(id);
        this.jumpToNonce.update((nonce) => nonce + 1);
      });
    } else if (this.canLoadOlder()) {
      if (!this.loadingOlder()) untracked(() => this.pageToReveal(id));
    } else if (
      !this.loadingOlder() &&
      // Root only: the replies have not arrived yet, so nothing is known to be missing.
      this.oldestReplyId() !== null &&
      this.revealMissing !== id
    ) {
      // Not marked revealed: a reply that still arrives live is jumped to after all.
      this.revealMissing = id;
      untracked(() => this.revealFailed.emit());
    }
  });

  constructor() {
    // Otherwise a thread closed by a press or key inside it stays in memory, detached, as
    // the CDK's last input target until the next one.
    releaseInputTargetOnDestroy();
  }

  ngOnDestroy(): void {
    this.openedThread()?.release();
    this.openedThread.set(null);
    // Closing the panel mid-reply otherwise leaves us marked as typing until the server's
    // TYPING_TIMEOUT_MS lapses. Owner-keyed, so it cannot clear the flag while the main
    // composer still holds a draft.
    this.timeline.setTyping(false, 'thread');
  }

  /**
   * Which way a thread reply is dragged to act on it.
   *
   * Read from the preference DIRECTLY, unlike the main timeline, whose page forces the
   * gesture off while the drawer is open: this panel only exists while the drawer is open,
   * so that rule would leave the gesture dead here. The competition with the drawer's own
   * close-drag is resolved at the row: an armed swipe stops the `pointerdown` from reaching
   * it (see `armSwipe`). Still phones only: above `max-width: 1099.98px` the scroller does
   * not claim the horizontal axis and the browser eats the drag.
   */
  protected readonly swipeDirection = computed<SwipeDirection>(() =>
    this.belowMembers() && isMobileOs() ? this.gestures.messageSwipe() : 'off',
  );

  private readonly gestures = inject(MessageGestureSettingsService);
  private readonly belowMembers = mediaQuerySignal(
    BELOW_MEMBERS_QUERY,
    inject(DestroyRef),
  );

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

  private pageToReveal(id: string): void {
    this.openedThread()
      ?.loadOlder()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        if (outcome.kind === 'rejected') {
          this.revealedEventId = id;
          this.revealFailed.emit();
        }
      });
  }

  onBatchCaption(caption: ComposerSubmit): void {
    this.commands.sendCaption(caption);
  }

  /**
   * The room's typists, for the row above the thread composer. Room's, not thread's:
   * `m.typing` is a room-level EDU with no thread dimension, so somebody typing in the main
   * timeline shows here too. The row announces only per {@link announceTyping}; otherwise the
   * room's list beside it announces the same names.
   */
  protected readonly typingNames = this.timeline.typingNames;

  /**
   * Composer typing state → the room's (throttled) typing notification. Tagged `'thread'`
   * so a send here cannot clear the flag while the main composer still holds a draft:
   * `m.typing` is one flag per room and both composers feed it.
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

  onCancelEdit(): void {
    this.commands.cancelEdit();
  }

  onCancelReply(): void {
    this.commands.cancelReply();
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

  onCancelSend(messageId: string): void {
    this.commands.cancel(messageId);
  }

  /** A delete the list has already confirmed. */
  onDelete(messageId: string): void {
    this.commands.delete(messageId);
  }
}
