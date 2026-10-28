import {
  DestroyRef,
  Injectable,
  type Signal,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  type Observable,
  type Subscription,
  defer,
  finalize,
  map,
  of,
} from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  SESSION_ENGINE,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import { ImagePackEditorService } from '@trinity/data-access/media';
import { DraftStoreService } from '@trinity/platform-native';
import {
  type Mention,
  applyVectorDiffs,
  initialOf,
  outgoingReplyText,
  renderMarkdown,
  slashCommandContent,
  textMessageContent,
  unwrapEngineResult,
} from '@trinity/util/matrix';
import { onWindowFocus, windowHasFocus } from './window-focus';
import type { MessageView } from './message-presentation';
import type { ConversationKey } from './conversation-messages';
import { CONVERSATION_MESSAGE_ADAPTER } from './conversation-message-adapter.service';
import { CONVERSATION_ATTENTION } from './conversation-attention.port';
import type { ThreadSummary } from './conversation-threads';
import { threadDraftKey } from './conversation-draft-key';
import { outgoingText } from './conversation-text-sender.service';
import { keepWhileWaiting } from './waiting-draft';
import type {
  OutgoingText,
  ThreadSummaryInfo,
  TimelineFocus,
} from './timeline-engine';
import { TIMELINE_ENGINE } from './timeline-engine.token';
import { profileName } from './timeline-item-presentation';
import { unencryptedShield } from './shield-presentation';
import { type TimelineStore, TimelineStores } from './timeline-store';

/** Older thread replies pulled in per backward-pagination round. */
const THREAD_SCROLLBACK = 30;
const NO_MESSAGES: readonly MessageView[] = [];
const NO_SUMMARIES: readonly ThreadSummaryInfo[] = [];

function threadFocus(rootEventId: string): TimelineFocus {
  return { kind: 'thread', rootEventId };
}

/** The summary a thread indicator renders, its names resolved from the summary's profiles. */
function presentSummary(info: ThreadSummaryInfo): ThreadSummary {
  const name = (userId: string): string =>
    profileName(userId, info.profiles[userId]);
  const { root, latestReply } = info;
  return {
    rootEventId: info.rootEventId,
    rootPreview: root?.preview ?? null,
    rootSenderName: root ? name(root.sender) : null,
    rootShield: unencryptedShield(root?.unencryptedMark ?? null),
    replyCount: info.replyCount,
    latestReplyTs: latestReply?.ts ?? null,
    latestActivityTs: info.latestActivityTs,
    latestReplyPreview: latestReply?.preview ?? null,
    latestReplySenderName: latestReply ? name(latestReply.sender) : null,
    latestReplyShield: unencryptedShield(latestReply?.unencryptedMark ?? null),
    participants: info.participants.map((id) => {
      const participant = name(id);
      return {
        id,
        name: participant,
        initial: initialOf(participant),
        avatarMxc: info.profiles[id]?.avatarMxc ?? null,
      };
    }),
    unreadCount: info.unreadCount,
    highlight: info.highlight,
  };
}

/**
 * A room's threads, read from the timeline engine. Two independent views:
 *
 *  - {@link summaries}: thread-root id to {@link ThreadSummary} for the exact room, bound
 *    with {@link attach}/{@link close}, feeding the main timeline's thread indicators.
 *  - {@link threadMessages}: the {@link MessageView}s of a *single* opened thread (root
 *    first, then replies), read from its {@link TimelineStore} and bound with
 *    {@link attachThreadRoot}/{@link closeThread}.
 *
 * Text send/reply/edit are the package-internal adapter for the public exact-root child.
 * Message relations and staged media use the shared Conversation adapters, so no second
 * public action facade can drift from the room path.
 */
@Injectable()
export class ThreadsService {
  private readonly engine = inject(TIMELINE_ENGINE);
  private readonly stores = inject(TimelineStores);
  // Its emoticons() map is filled only while the rooms page subscribes run(); else it is empty.
  private readonly packs = inject(ImagePackEditorService);
  private readonly drafts = inject(DraftStoreService);
  private readonly messageAdapter = inject(CONVERSATION_MESSAGE_ADAPTER);
  private readonly attention = inject(CONVERSATION_ATTENTION, {
    optional: true,
  });
  private readonly session = inject(SessionStateService);
  private conversationKey: ConversationKey | null = null;
  private summariesSubscription: Subscription | null = null;
  /** The attached account's session generation the summaries feed was opened on. */
  private summariesGeneration: number | null = null;
  /** Each engine summary's presented form, so an unchanged summary keeps its identity. */
  private presented = new WeakMap<ThreadSummaryInfo, ThreadSummary>();
  private summaryInfos: readonly ThreadSummaryInfo[] = NO_SUMMARIES;
  private readonly _summaries = signal<Record<string, ThreadSummary>>({});
  private readonly store = signal<TimelineStore | null>(null);
  private storeUpdates: Subscription | null = null;
  // Latest thread event we have already sent a read receipt for, so live replies
  // arriving while the thread is open mark read without re-sending on every update.
  private lastReadEventId: string | null = null;
  private threadReceiptSubscription: Subscription | null = null;
  // The window regained focus with a thread open: send the receipt held back meanwhile.
  private readonly onThreadFocus = (): void => this.markThreadRead();
  private stopThreadFocusListener: (() => void) | null = null;

  /** Thread summaries for the active room, keyed by thread-root event id. */
  readonly summaries = this._summaries.asReadonly();

  /**
   * The active room's threads as a flat list, newest activity first (drives the threads-list
   * panel); derived from {@link summaries}.
   */
  readonly threadList = computed<ThreadSummary[]>(() =>
    Object.values(this._summaries()).sort(
      (a, b) =>
        b.latestActivityTs - a.latestActivityTs ||
        a.rootEventId.localeCompare(b.rootEventId),
    ),
  );

  /** Live, decrypted messages of the opened thread (root first, then replies). */
  readonly threadMessages: Signal<readonly MessageView[]> = computed(
    () => this.store()?.messages() ?? NO_MESSAGES,
  );

  /** The root event id of the currently opened thread, or null. */
  readonly openThreadRootId: Signal<string | null> = computed(() => {
    const focus = this.store()?.focus;
    return focus?.kind === 'thread' ? focus.rootEventId : null;
  });

  /** Whether an older-replies page is currently loading in the opened thread. */
  readonly loadingOlderThread = computed(
    () => this.store()?.backPagination() === 'paginating',
  );

  /** Whether the opened thread has older replies left to page in. */
  readonly canPaginateThread = computed(() => {
    const store = this.store();
    return !!store?.available() && store.backPagination() === 'idle';
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.closeThread();
      this.close();
    });
    // A restarted account's summaries come from its new client, not the stopped one.
    inject(SESSION_ENGINE)
      .session()
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.followSession());
    // App lock released: ack the open thread's replies that arrived behind the cover.
    effect(() => {
      if (this.attention?.attentive()) untracked(() => this.markThreadRead());
    });
  }

  // Approximate diagnostics: the js-sdk engine's listeners per open feed, not counted live.
  resources(): { listenerCount: number; retainedBytes: number } {
    const summaryListeners = this.summariesSubscription ? 8 : 0;
    const threadListeners = this.store() ? 11 : 0;
    const threadFocusListeners = this.stopThreadFocusListener ? 1 : 0;
    return {
      listenerCount: summaryListeners + threadListeners + threadFocusListeners,
      retainedBytes:
        untracked(this.threadMessages).length * 8 +
        Object.keys(untracked(this._summaries)).length * 8,
    };
  }

  /** Start projecting a room's thread summaries; a no-op while that room is attached. */
  attach(key: ConversationKey): void {
    const current = this.conversationKey;
    if (
      current?.accountId === key.accountId &&
      current.roomId === key.roomId &&
      this.summariesSubscription
    ) {
      return;
    }
    this.close();
    this.conversationKey = Object.freeze({ ...key });
    this.summariesGeneration = this.generationOf(key.accountId);
    this.summariesSubscription = this.engine
      .threadSummaries(key.accountId, key.roomId)
      .subscribe((diffs) => {
        this.summaryInfos = applyVectorDiffs(this.summaryInfos, diffs);
        const summaries: Record<string, ThreadSummary> = {};
        for (const info of this.summaryInfos) {
          let summary = this.presented.get(info);
          if (!summary) {
            summary = presentSummary(info);
            this.presented.set(info, summary);
          }
          summaries[info.rootEventId] = summary;
        }
        this._summaries.set(summaries);
      });
  }

  /** Stop the summaries feed and clear the summaries map. */
  close(): void {
    this.summariesSubscription?.unsubscribe();
    this.summariesSubscription = null;
    this.conversationKey = null;
    this.summaryInfos = NO_SUMMARIES;
    this.presented = new WeakMap();
    this._summaries.set({});
  }

  /** Open a single thread of the attached room into {@link threadMessages}. */
  attachThreadRoot(rootEventId: string): void {
    this.closeThread();
    const key = this.conversationKey;
    if (!key || !rootEventId) return;
    // A thread that does not exist yet ("Reply in thread" on a plain message) shows its
    // root alone; the engine starts it on the first send, so an abandoned one leaves none.
    const store = this.stores.open(key, threadFocus(rootEventId));
    this.store.set(store);
    this.storeUpdates = store.updates.subscribe(() => this.markThreadRead());
    this.stopThreadFocusListener = onWindowFocus(this.onThreadFocus);
    this.markThreadRead();
  }

  /** Close the opened thread's store and clear its messages. */
  closeThread(): void {
    this.threadReceiptSubscription?.unsubscribe();
    this.threadReceiptSubscription = null;
    this.stopThreadFocusListener?.();
    this.stopThreadFocusListener = null;
    this.storeUpdates?.unsubscribe();
    this.storeUpdates = null;
    this.store()?.close();
    this.store.set(null);
    this.lastReadEventId = null;
  }

  /** Page in older replies for the opened thread. */
  paginateOpenThread(): Observable<void> {
    return defer(() => {
      const store = this.store();
      if (!store || !this.canPaginateThread()) return of(void 0);
      const { accountId, roomId } = store.key;
      return this.engine
        .paginateBackwards(accountId, roomId, store.focus, THREAD_SCROLLBACK)
        .pipe(
          unwrapEngineResult(),
          map(() => void 0),
        );
    });
  }

  // --- In-thread composing --------------------------------------------------
  // Each action builds its text like the room composer and sends it with the opened
  // thread's root, so the message stays in the thread and its echo and failed/retry state
  // surface through `threadMessages`. The thread is resolved on subscribe.

  sendToThread(body: string, mentions: Mention[] = []): Observable<void> {
    const text = body.trim();
    return defer(() => {
      const key = this.threadKey();
      if (!key || !text) return of(void 0);
      // A leading slash command (/me, /shrug, /plain, /spoiler) rewrites the content as in
      // the main composer; otherwise mentions carry `m.mentions` + matrix.to pills.
      const render = (value: string) =>
        renderMarkdown(value, this.packs.emoticons());
      const content =
        slashCommandContent(text, render, mentions) ??
        textMessageContent(text, render(text), mentions);
      return this.sendText(key, outgoingText(content), text, null);
    });
  }

  /** Edit an own message in the thread via an `m.replace` (stays in the thread). */
  editInThread(
    messageId: string,
    newBody: string,
    mentions: Mention[] = [],
  ): Observable<void> {
    const text = newBody.trim();
    return defer(() => {
      const key = this.threadKey();
      if (!key || !text) return of(void 0);
      const rendered = renderMarkdown(text, this.packs.emoticons());
      return this.engine
        .edit(
          key.accountId,
          key.roomId,
          { eventId: messageId, transactionId: null },
          // The engine adds the `m.replace` relation and the `* ` fallback around it.
          outgoingText(textMessageContent(text, rendered, mentions)),
          { threadRootId: key.rootEventId },
        )
        .pipe(
          unwrapEngineResult(),
          map(() => void 0),
        );
    });
  }

  /**
   * Reply to a specific message inside the thread: an explicit `m.in_reply_to`, so the
   * thread relation has `is_falling_back: false` — a genuine in-thread reply that quotes it.
   */
  replyInThread(
    messageId: string,
    body: string,
    mentions: Mention[] = [],
  ): Observable<void> {
    const text = body.trim();
    return defer(() => {
      const key = this.threadKey();
      if (!key || !text) return of(void 0);
      const reply = outgoingReplyText(
        text,
        renderMarkdown(text, this.packs.emoticons()),
        mentions,
      );
      return this.sendText(key, reply, text, messageId);
    });
  }

  /** A send that failed offline waits in the thread, its text kept aside for a reload. */
  private sendText(
    key: ConversationKey & { readonly rootEventId: string },
    text: OutgoingText,
    body: string,
    replyTo: string | null,
  ): Observable<void> {
    const { accountId, roomId, rootEventId } = key;
    const transactionId = `trinity-${crypto.randomUUID()}`;
    // Held per send: the echo's state is watched past the thread's lifetime.
    const { store, release } = this.stores.hold(
      { accountId, roomId },
      threadFocus(rootEventId),
    );
    let watching = false;
    return this.engine
      .send(
        accountId,
        roomId,
        { kind: 'text', ...text },
        { threadRootId: rootEventId, replyTo, transactionId },
      )
      .pipe(
        unwrapEngineResult(),
        map(({ eventId }) => {
          if (eventId !== null) return;
          watching = keepWhileWaiting(
            this.drafts,
            threadDraftKey(rootEventId),
            body,
            {
              transactionId,
              states: store.sendStates(transactionId).pipe(finalize(release)),
            },
          );
          if (!watching) throw new Error('The thread reply was not sent.');
        }),
        finalize(() => {
          if (!watching) release();
        }),
      );
  }

  /** The opened thread's Account, Room and root, or null when nothing is composable. */
  private threadKey():
    (ConversationKey & { readonly rootEventId: string }) | null {
    const key = this.conversationKey;
    const rootEventId = this.openThreadRootId();
    return key && rootEventId ? { ...key, rootEventId } : null;
  }

  /**
   * Send a thread-scoped read receipt for the opened thread's latest confirmed reply,
   * clearing its unread badge, unless App lock covers the app or the window is unfocused.
   * The root alone is no reply to acknowledge. Best-effort: a rejected receipt is retried
   * on the next update.
   */
  private markThreadRead(): void {
    // Open, but nobody is looking at an unfocused window: hold the receipt so the thread
    // stays unread; onThreadFocus sends it for the latest reply when focus returns.
    if (!windowHasFocus()) return;
    const store = untracked(this.store);
    const rootEventId = untracked(this.openThreadRootId);
    if (!store || !rootEventId || !untracked(store.available)) return;
    // Covered by App lock: nobody is looking; the attention effect re-acks after unlock.
    if (this.attention && !untracked(this.attention.attentive)) return;
    const id = untracked(store.room)?.latestConfirmedEventId ?? null;
    if (!id || id === rootEventId || id === this.lastReadEventId) return;
    this.lastReadEventId = id;
    this.threadReceiptSubscription?.unsubscribe();
    this.threadReceiptSubscription = this.messageAdapter
      .acknowledge({ key: store.key, messageId: id, threadRootId: rootEventId })
      .subscribe((outcome) => {
        if (outcome.kind === 'rejected' && this.lastReadEventId === id) {
          this.lastReadEventId = null;
        }
      });
  }

  /** Reopens the summaries feed when the attached account's session generation changes. */
  private followSession(): void {
    const key = this.conversationKey;
    if (!key || this.generationOf(key.accountId) === this.summariesGeneration) {
      return;
    }
    this.close();
    this.attach(key);
  }

  private generationOf(accountId: string): number | null {
    return untracked(() => this.session.status(accountId))?.generation ?? null;
  }
}
