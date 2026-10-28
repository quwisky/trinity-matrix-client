import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  Direction,
  EventStatus,
  EventType,
  MatrixEvent,
  MatrixEventEvent,
  RoomEvent,
  RoomStateEvent,
  ThreadEvent,
  type MatrixClient,
  type Room,
  type RoomMember,
  type RoomState,
  type Thread,
} from 'matrix-js-sdk';
import {
  Observable,
  Subscription,
  catchError,
  defer,
  finalize,
  from,
  map,
  of,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import {
  ImagePackEditorService,
  MediaPipeline,
} from '@trinity/data-access/media';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import { RoomEncryptionFlags } from '@trinity/util/matrix';
import {
  collectMessageSenders,
  isDisplayableMessage,
  mapStatus,
} from './js-sdk/event-reads';
import {
  resolveShieldsInto,
  resolvedShields,
  shieldsToCheck,
  shownContent,
  shownShield,
  shownSubject,
  unencryptedShieldFor,
} from './js-sdk/shields';
import { shieldKey } from './shield-presentation';
import { eventRevision } from './js-sdk/event-revision';
import { onWindowFocus, windowHasFocus } from './window-focus';
import { projectMessage } from './js-sdk/project-message';
import type { MessageShield, MessageView } from './message-presentation';
import type { SendState } from './timeline-engine';
import type { ConversationKey } from './conversation-messages';
import { CONVERSATION_MESSAGE_ADAPTER } from './conversation-message-adapter.service';
import { CONVERSATION_ATTENTION } from './conversation-attention.port';
import type { ThreadSummary } from './conversation-threads';
import { DraftStoreService } from '@trinity/platform-native';
import { threadDraftKey } from './conversation-draft-key';
import { keepWhileWaiting } from './waiting-draft';
import {
  participantsOf,
  threadSummaryRevision,
  threadUnread,
} from './thread-summary';
import { replyMessageContent } from './js-sdk/outgoing-content';
import {
  editMessageContent,
  messagePreview,
  outgoingReplyText,
  renderMarkdown,
  slashCommandContent,
  textMessageContent,
  type Mention,
} from '@trinity/util/matrix';

/** Older thread replies pulled in per backward-pagination round. */
const THREAD_SCROLLBACK = 30;

/**
 * Projects a room's threads into render-ready signals, mirroring {@link TimelineService}'s
 * shape (instance-keyed connect/disconnect, defensive handlers, async-decryption
 * re-mapping). Two independent views:
 *
 *  - {@link summaries}: thread-root id to {@link ThreadSummary} for the exact room, bound
 *    with {@link attach}/{@link close}, feeding the main timeline's thread indicators.
 *  - {@link threadMessages}: the live, decrypted {@link MessageView}s of a *single* opened
 *    thread (root first, then replies), bound with {@link attachThreadRoot}/
 *    {@link closeThread}.
 *
 * Text send/reply/edit are the package-internal SDK adapter for the public exact-root
 * child. Message relations and staged media use the shared Conversation adapters, so no
 * second public action facade can drift from the room path.
 */
@Injectable()
export class ThreadsService {
  private readonly mediaPipeline = inject(MediaPipeline);
  // Its emoticons() map is filled only while the rooms page subscribes run(); else it is empty.
  private readonly packs = inject(ImagePackEditorService);
  private readonly drafts = inject(DraftStoreService);
  private readonly messageAdapter = inject(CONVERSATION_MESSAGE_ADAPTER);
  private readonly attention = inject(CONVERSATION_ATTENTION, {
    optional: true,
  });
  private conversationKey: ConversationKey | null = null;

  private readonly _summaries = signal<Record<string, ThreadSummary>>({});
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

  private readonly _threadMessages = signal<MessageView[]>([]);
  /** Live, decrypted messages of the opened thread (root first, then replies). */
  readonly threadMessages = this._threadMessages.asReadonly();

  private readonly _openThreadRootId = signal<string | null>(null);
  /** The root event id of the currently opened thread, or null. */
  readonly openThreadRootId = this._openThreadRootId.asReadonly();

  private readonly _loadingOlderThread = signal(false);
  /** Whether an older-replies page is currently loading in the opened thread. */
  readonly loadingOlderThread = this._loadingOlderThread.asReadonly();

  private readonly _canPaginateThread = signal(false);
  /** Whether the opened thread has older replies left to page in. */
  readonly canPaginateThread = this._canPaginateThread.asReadonly();

  // Latest thread event we have already sent a read receipt for, so live replies
  // arriving while the thread is open mark read without re-sending on every refresh.
  private lastReadEventId: string | null = null;
  private threadReceiptSubscription: Subscription | null = null;
  // The window regained focus with a thread open: send the receipt held back meanwhile.
  private readonly onThreadFocus = (): void => this.markThreadRead();
  private stopThreadFocusListener: (() => void) | null = null;

  // --- Summaries (active room) ---------------------------------------------
  /**
   * The exact Account client {@link attach} bound; re-reading a mutable active pointer on
   * close would detach from the new client and leak this listener on the old one.
   */
  private summariesClient: MatrixClient | null = null;
  private summariesRoom: Room | null = null;
  private summariesRoomId: string | null = null;
  /** Whether the summaries' room counts as encrypted: its state, or else its crypto store. */
  private summariesEncryption = new RoomEncryptionFlags();

  // Per-thread summary cache by thread-root id: the summary plus a `rev` fingerprint of
  // everything {@link summaryFor} reads (see {@link threadSummaryRevision}). A summary is
  // rebuilt only when its fingerprint changes, so a message in one thread doesn't rebuild
  // the others and unchanged thread-root rows keep their identity.
  private readonly summaryCache = new Map<
    string,
    { rev: string; summary: ThreadSummary }
  >();

  private readonly onSummariesChanged = (): void => this.refreshSummaries();
  private readonly onSummariesDecrypted = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.summariesRoomId) {
      this.refreshSummaries();
    }
  };
  // A summary renders participant and root/latest sender names + avatars resolved from
  // membership, which can arrive (lazy loading) or change later. The revision deliberately
  // does NOT walk participant avatars (a member scan on every refresh), so drop the
  // summaries the changed member takes part in and let refreshSummaries rebuild just those.
  // The cached participant list is the gate: an unreferenced member matches nothing.
  private readonly onSummariesMember = (
    _event: MatrixEvent,
    _state: RoomState,
    member: RoomMember,
  ): void => {
    if (member.roomId !== this.summariesRoomId) {
      return;
    }
    let invalidated = false;
    for (const [id, entry] of this.summaryCache) {
      if (entry.summary.participants.some((p) => p.id === member.userId)) {
        this.summaryCache.delete(id);
        invalidated = true;
      }
    }
    if (invalidated) {
      this.refreshSummaries();
    }
  };

  // --- Opened thread --------------------------------------------------------
  private thread: Thread | null = null;
  /** Root of the open thread once a page came back with nothing new, so no further page is offered. */
  private exhaustedThreadRootId: string | null = null;
  /** The exact Account client {@link attachThreadRoot} inherited — see {@link summariesClient}. */
  private threadClient: MatrixClient | null = null;
  private threadRoom: Room | null = null;
  private threadRoomId: string | null = null;

  // Users the opened thread renders a member for (each sender plus each reply's quoted
  // sender), recomputed every refresh so the member listener re-maps only for these, not
  // once per member of a lazy member-load.
  private threadRelevantSenders = new Set<string>();

  /**
   * Resolved authenticity shields for the opened thread's events, by shield-subject id (a
   * reply's latest edit, else the event itself).
   */
  /** Whether this opened thread has checked its shields afresh (see `resolvedShields`). */
  private threadShieldsChecked = false;
  /** Whether the opened thread's room counts as encrypted: its state, or else its crypto store. */
  private threadEncryption = new RoomEncryptionFlags();
  /**
   * Per-reply projection cache by event id, mirroring TimelineService's row cache: `rev`
   * fingerprints everything Message Presentation reads that can change while the thread is
   * open (the async shield folded in). refreshThread is driven by Timeline/LocalEcho/
   * Decrypted/Members, so without it a keystroke echo re-ran markdown + DOMPurify for EVERY
   * reply and gave every OnPush row a new identity.
   */
  private threadViewCache = new Map<
    string,
    { rev: string; view: MessageView }
  >();

  // Trust changed: a thread message's shield may flip, so force a full re-resolve of the
  // opened thread's shields (mirrors TimelineService).
  private readonly onThreadTrust = (): void => {
    if (this.threadRoom) {
      void this.resolveThreadShields(this.threadRoom, true);
    }
  };

  private readonly onThreadChanged = (): void => this.refreshThread();
  private readonly onThreadDecrypted = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.threadRoomId) {
      this.refreshThread();
    }
  };
  // A quoted sender's name/avatar can arrive after its reply (lazy loading), leaving the
  // reply preview on the raw mxid + initials; re-map when a member the thread references
  // loads or changes.
  private readonly onThreadMember = (
    _event: MatrixEvent,
    _state: RoomState,
    member: RoomMember,
  ): void => {
    if (
      member.roomId === this.threadRoomId &&
      this.threadRelevantSenders.has(member.userId)
    ) {
      this.refreshThread();
    }
  };
  // Who may end a poll follows the room's power levels.
  private readonly onThreadPowerLevels = (event: MatrixEvent): void => {
    if (
      event.getRoomId() === this.threadRoomId &&
      event.getType() === EventType.RoomPowerLevels
    ) {
      this.refreshThread();
    }
  };
  // A thread can be created by our own first in-thread reply: bind to it lazily so
  // the optimistic echo (and later replies) flow into the view.
  private readonly onThreadCreated = (thread: Thread): void => {
    if (!this.thread && thread.id === this._openThreadRootId()) {
      this.attachThread(thread);
    }
    this.refreshThread();
  };

  constructor() {
    // App lock released: ack the open thread's replies that arrived behind the cover.
    effect(() => {
      if (this.attention?.attentive()) untracked(() => this.markThreadRead());
    });
  }

  resources(): { listenerCount: number; retainedBytes: number } {
    const summaryListeners = this.summariesRoom ? 7 : 0;
    const summaryClientListeners = this.summariesClient ? 1 : 0;
    const threadRoomListeners = this.threadRoom ? 4 : 0;
    const threadClientListeners = this.threadClient ? 4 : 0;
    const threadListeners = this.thread ? 3 : 0;
    const threadFocusListeners = this.stopThreadFocusListener ? 1 : 0;
    return {
      listenerCount:
        summaryListeners +
        summaryClientListeners +
        threadRoomListeners +
        threadClientListeners +
        threadListeners +
        threadFocusListeners,
      retainedBytes:
        this._threadMessages().length * 8 +
        Object.keys(this._summaries()).length * 8,
    };
  }

  /** Start projecting a room's thread summaries; attaches live + decryption listeners. */
  attach(key: ConversationKey, client: MatrixClient): void {
    if (
      this.summariesRoomId === key.roomId &&
      this.summariesClient === client
    ) {
      return;
    }
    this.close();
    const room = client.getRoom(key.roomId);
    if (!room || client.getUserId() !== key.accountId) {
      return;
    }

    this.conversationKey = Object.freeze({ ...key });
    this.summariesRoomId = key.roomId;
    this.summariesRoom = room;
    this.summariesClient = client;
    this.summariesEncryption = new RoomEncryptionFlags();
    void this.summariesEncryption
      .refresh(client.getCrypto?.(), room.roomId)
      .then((encrypted) => {
        if (encrypted && this.summariesRoom === room) this.refreshSummaries();
      });
    // The room re-emits its threads' Update/NewReply + Timeline, so listening at
    // the room level covers new threads, new replies, and reply-count changes.
    room.on(ThreadEvent.New, this.onSummariesChanged);
    room.on(ThreadEvent.Update, this.onSummariesChanged);
    room.on(ThreadEvent.NewReply, this.onSummariesChanged);
    room.on(RoomEvent.Timeline, this.onSummariesChanged);
    // Per-thread unread badges: UnreadNotifications fires when a thread's counts
    // change, and Receipt fires when our (or another) read receipt clears them.
    room.on(RoomEvent.UnreadNotifications, this.onSummariesChanged);
    room.on(RoomEvent.Receipt, this.onSummariesChanged);
    // Participant names/avatars resolve from membership, which can load/change late.
    room.on(RoomStateEvent.Members, this.onSummariesMember);
    client.on(MatrixEventEvent.Decrypted, this.onSummariesDecrypted);
    this.refreshSummaries();
  }

  /** Detach summary listeners and clear the summaries map. */
  close(): void {
    const room = this.summariesRoom;
    if (room) {
      room.off(ThreadEvent.New, this.onSummariesChanged);
      room.off(ThreadEvent.Update, this.onSummariesChanged);
      room.off(ThreadEvent.NewReply, this.onSummariesChanged);
      room.off(RoomEvent.Timeline, this.onSummariesChanged);
      room.off(RoomEvent.UnreadNotifications, this.onSummariesChanged);
      room.off(RoomEvent.Receipt, this.onSummariesChanged);
      room.off(RoomStateEvent.Members, this.onSummariesMember);
    }
    // Detach from the exact Account client attach() bound.
    this.summariesClient?.off(
      MatrixEventEvent.Decrypted,
      this.onSummariesDecrypted,
    );
    this.summariesClient = null;
    this.conversationKey = null;
    this.summariesRoom = null;
    this.summariesRoomId = null;
    this.summaryCache.clear();
    this._summaries.set({});
  }

  /**
   * Open a single thread for viewing: project the root + its replies into
   * {@link threadMessages} and attach live + decryption listeners on the thread.
   */
  attachThreadRoot(rootEventId: string): void {
    this.closeThread();
    const client = this.summariesClient;
    const room = this.summariesRoom;
    if (!client || !room || !rootEventId) {
      return;
    }

    this.threadRoom = room;
    this.threadRoomId = room.roomId;
    this.threadClient = client;
    this._openThreadRootId.set(rootEventId);
    // Attach an already-aggregated Thread (e.g. from a "N replies" indicator). When none
    // exists ("Reply in thread" on a plain message), leave the view root-only and do NOT
    // create one: it would leave an empty 0-reply thread if the user never sends. It is
    // created lazily on the first send (`ensureThread`); `ThreadEvent.New` still attaches
    // it if a remote reply forms it meanwhile.
    const thread = room.getThread(rootEventId);
    if (thread) {
      this.attachThread(thread);
    }
    // New replies and reply-count changes arrive on the thread; the local echo's send-status
    // transitions arrive at the room level, so listen there too.
    room.on(ThreadEvent.New, this.onThreadCreated);
    room.on(RoomEvent.LocalEchoUpdated, this.onThreadChanged);
    room.on(RoomStateEvent.Members, this.onThreadMember);
    room.on(RoomStateEvent.Events, this.onThreadPowerLevels);
    // A reply's "seen by" avatars follow the read markers, and a receipt is none of the
    // thread-level events above; the summaries and main timeline bind it too. Without it a
    // receipt surfaces only when an unrelated event re-refreshes.
    room.on(RoomEvent.Receipt, this.onThreadChanged);
    client.on(MatrixEventEvent.Decrypted, this.onThreadDecrypted);
    client.on(CryptoEvent.UserTrustStatusChanged, this.onThreadTrust);
    client.on(CryptoEvent.DevicesUpdated, this.onThreadTrust);
    client.on(CryptoEvent.KeysChanged, this.onThreadTrust);
    this.stopThreadFocusListener = onWindowFocus(this.onThreadFocus);
    this.refreshThread();
  }

  /** Detach the opened thread's listeners and clear its messages. */
  closeThread(): void {
    const thread = this.thread;
    if (thread) {
      thread.off(ThreadEvent.Update, this.onThreadChanged);
      thread.off(ThreadEvent.NewReply, this.onThreadChanged);
      thread.off(RoomEvent.Timeline, this.onThreadChanged);
    }
    const room = this.threadRoom;
    if (room) {
      room.off(ThreadEvent.New, this.onThreadCreated);
      room.off(RoomEvent.LocalEchoUpdated, this.onThreadChanged);
      room.off(RoomStateEvent.Members, this.onThreadMember);
      room.off(RoomStateEvent.Events, this.onThreadPowerLevels);
      room.off(RoomEvent.Receipt, this.onThreadChanged);
    }
    // Detach from the exact Account client attachThreadRoot() inherited.
    const client = this.threadClient;
    if (client) {
      client.off(MatrixEventEvent.Decrypted, this.onThreadDecrypted);
      client.off(CryptoEvent.UserTrustStatusChanged, this.onThreadTrust);
      client.off(CryptoEvent.DevicesUpdated, this.onThreadTrust);
      client.off(CryptoEvent.KeysChanged, this.onThreadTrust);
    }
    this.threadClient = null;
    this.thread = null;
    this.exhaustedThreadRootId = null;
    this.threadRoom = null;
    this.threadRoomId = null;
    this.threadReceiptSubscription?.unsubscribe();
    this.threadReceiptSubscription = null;
    this.stopThreadFocusListener?.();
    this.stopThreadFocusListener = null;
    this.lastReadEventId = null;
    this.threadRelevantSenders.clear();
    this.threadShieldsChecked = false;
    this.threadEncryption = new RoomEncryptionFlags();
    this.threadViewCache.clear();
    this._openThreadRootId.set(null);
    this._threadMessages.set([]);
    this._canPaginateThread.set(false);
    this._loadingOlderThread.set(false);
  }

  /** Bind to a thread's live + reply listeners (shared by open and lazy creation). */
  private attachThread(thread: Thread): void {
    this.thread = thread;
    thread.on(ThreadEvent.Update, this.onThreadChanged);
    thread.on(ThreadEvent.NewReply, this.onThreadChanged);
    thread.on(RoomEvent.Timeline, this.onThreadChanged);
  }

  /**
   * Page in older replies for the opened thread (backward pagination over the thread's own
   * live timeline), mirroring {@link TimelineService.loadOlder}. Prepended replies are
   * re-mapped into {@link threadMessages} like the live path. The `loadingOlder` flag is
   * reset on success *or* error so a failed page can't wedge pagination off.
   */
  paginateOpenThread(): Observable<void> {
    const thread = this.thread;
    const timeline = thread?.liveTimeline ?? null;
    if (
      !thread ||
      !timeline ||
      this._loadingOlderThread() ||
      !this.threadClient
    ) {
      return of(void 0);
    }
    // Sampled before the request: the SDK adds the page's events (and re-enters
    // refreshThread through the timeline events) before the promise resolves.
    let loadedBefore = 0;
    return defer(() => {
      const client = this.threadClient;
      if (!client || this.thread !== thread) return of(void 0);
      this._loadingOlderThread.set(true);
      loadedBefore = thread.events.length;
      return from(
        client.paginateEventTimeline(timeline, {
          backwards: true,
          limit: THREAD_SCROLLBACK,
        }),
      );
    }).pipe(
      tap(() => {
        // A page that brought no events at all (hidden replies the count still includes)
        // must not leave the button offering the same empty page again.
        if (thread.events.length === loadedBefore) {
          this.exhaustedThreadRootId = thread.id;
        }
        this.refreshThread();
      }),
      finalize(() => this._loadingOlderThread.set(false)),
      map(() => void 0),
    );
  }

  // --- In-thread composing --------------------------------------------------
  // Each action mirrors the matching TimelineService method (sharing the content builders)
  // but passes the opened thread's root id as the SDK `threadId`, so the message stays in
  // the thread and its echo and failed/retry state surface through `threadMessages`.

  /**
   * Create + attach the Thread just before the first reply is sent, if none exists.
   * matrix-js-sdk doesn't form a Thread from the sender's own first reply: the echo is
   * treated as threaded (kept out of the main timeline) but no Thread is created, so the
   * reply would vanish. Creating it only on send avoids an empty 0-reply thread when a
   * thread is merely opened then abandoned. No-op once attached/aggregated.
   */
  private ensureThread(room: Room, rootEventId: string): Observable<void> {
    if (this.thread) {
      return of(void 0);
    }
    const existing = room.getThread(rootEventId);
    if (existing) {
      this.attachThread(existing);
      return of(void 0);
    }
    const local = room.findEventById(rootEventId);
    if (local) {
      this.createThreadFromRoot(room, rootEventId, local);
      return of(void 0);
    }
    // The root isn't in memory (e.g. an old thread scrolled out of the live timeline). The
    // SDK would still route a threaded send, but with no local Thread the echo has nowhere
    // to land and vanishes. Fetch the root to create the Thread; if that fails, surface the
    // error rather than send a reply that won't show.
    const client = this.threadClient;
    if (!client) return of(void 0);
    return from(client.fetchRoomEvent(room.roomId, rootEventId)).pipe(
      map((raw) =>
        this.createThreadFromRoot(room, rootEventId, new MatrixEvent(raw)),
      ),
    );
  }

  /** Create a Thread from its root event and attach it, unless a concurrent
   * `ThreadEvent.New` already did (createThread can emit it synchronously). */
  private createThreadFromRoot(
    room: Room,
    rootEventId: string,
    rootEvent: MatrixEvent,
  ): void {
    const created = room.createThread(rootEventId, rootEvent, [], false);
    if (!this.thread) {
      this.attachThread(created);
    }
  }

  sendToThread(body: string, mentions: Mention[] = []): Observable<void> {
    const text = body.trim();
    return defer(() => {
      const ctx = this.threadContext();
      if (!ctx || !text) {
        return of(void 0);
      }
      const { client, room, threadId } = ctx;
      // A leading slash command (/me, /shrug, /plain, /spoiler) rewrites the content as in
      // the main composer; otherwise build normal text content so mentions carry
      // `m.mentions` + matrix.to pills.
      const render = (value: string) =>
        renderMarkdown(value, this.packs.emoticons());
      const content =
        slashCommandContent(text, render, mentions) ??
        textMessageContent(text, render(text), mentions);
      // Ensure a local Thread exists (fetching the root if needed) *before*
      // sending, so the threaded echo has a home; a fetch failure aborts the send.
      return this.ensureThread(room, threadId).pipe(
        switchMap(() => this.sendText(client, room, threadId, content, text)),
      );
    }).pipe(map(() => void 0));
  }

  /** Edit an own message in the thread via an `m.replace` (stays in the thread). */
  editInThread(
    messageId: string,
    newBody: string,
    mentions: Mention[] = [],
  ): Observable<void> {
    const text = newBody.trim();
    return defer(() => {
      const ctx = this.threadContext();
      if (!ctx || !text) {
        return of(void 0);
      }
      const { client, roomId, threadId } = ctx;
      const content = editMessageContent(
        messageId,
        text,
        renderMarkdown(text, this.packs.emoticons()),
        mentions,
      );
      return from(client.sendMessage(roomId, threadId, content as never));
    }).pipe(map(() => void 0));
  }

  /**
   * Reply to a specific message inside the thread. The content carries an explicit
   * `m.in_reply_to`, so the SDK adds the thread relation with `is_falling_back:
   * false` — a genuine in-thread reply that quotes the target.
   */
  replyInThread(
    messageId: string,
    body: string,
    mentions: Mention[] = [],
  ): Observable<void> {
    const text = body.trim();
    return defer(() => {
      const ctx = this.threadContext();
      if (!ctx || !text) {
        return of(void 0);
      }
      const { client, room, threadId } = ctx;
      const content = replyMessageContent(
        room,
        messageId,
        outgoingReplyText(
          text,
          renderMarkdown(text, this.packs.emoticons()),
          mentions,
        ),
        undefined,
        shownContent,
      );
      return this.sendText(client, room, threadId, content, text);
    }).pipe(map(() => void 0));
  }

  /** A send that failed offline waits in the thread, its text kept aside for a reload. */
  private sendText(
    client: MatrixClient,
    room: Room,
    threadId: string,
    content: object,
    body: string,
  ): Observable<unknown> {
    const txnId = client.makeTxnId();
    return from(
      client.sendMessage(room.roomId, threadId, content as never, txnId),
    ).pipe(
      catchError((error: unknown) =>
        keepWhileWaiting(this.drafts, threadDraftKey(threadId), body, {
          transactionId: txnId,
          states: echoSendStates(room.getEventForTxnId(txnId)),
        })
          ? of(undefined)
          : throwError(() => error),
      ),
    );
  }

  /** The active opened-thread send context, or null when nothing is composable. */
  private threadContext(): {
    client: MatrixClient;
    room: Room;
    roomId: string;
    threadId: string;
  } | null {
    const room = this.threadRoom;
    const threadId = this._openThreadRootId();
    const client = this.threadClient;
    if (!room || !threadId || !client) {
      return null;
    }
    return {
      client,
      room,
      roomId: room.roomId,
      threadId,
    };
  }

  private refreshSummaries(): void {
    const room = this.summariesRoom;
    if (!room) {
      return;
    }
    const client = this.summariesClient;
    if (!client) return;
    const summaries: Record<string, ThreadSummary> = {};
    const seen = new Set<string>();
    const encrypted = this.summariesEncryption.isEncrypted(room);
    const unencryptedShield = unencryptedShieldFor(room, encrypted);
    for (const thread of room.getThreads()) {
      const id = thread.id;
      seen.add(id);
      // Reuse the cached summary (preserving its identity) unless this thread's
      // fingerprint changed; only the affected thread is rebuilt + merged in.
      const rev = `${threadSummaryRevision(room, thread)}\x1f${encrypted}`;
      const cached = this.summaryCache.get(id);
      if (cached && cached.rev === rev) {
        summaries[id] = cached.summary;
        continue;
      }
      const summary = this.summaryFor(client, room, thread, unencryptedShield);
      this.summaryCache.set(id, { rev, summary });
      summaries[id] = summary;
    }
    // Drop cache entries for threads no longer present.
    for (const id of [...this.summaryCache.keys()]) {
      if (!seen.has(id)) {
        this.summaryCache.delete(id);
      }
    }
    this._summaries.set(summaries);
  }

  private refreshThread(): void {
    const room = this.threadRoom;
    const rootEventId = this._openThreadRootId();
    if (!room || !rootEventId) {
      return;
    }
    const client = this.threadClient;
    if (!client) return;
    const thread = this.thread ?? room.getThread(rootEventId);
    const ordered = this.orderedThreadEvents(room, rootEventId, thread);

    const relevant = new Set<string>();
    const seenIds = new Set<string>();
    for (const e of ordered) {
      collectMessageSenders(client, room, e, relevant);
      seenIds.add(e.getId() ?? '');
    }
    this.threadRelevantSenders = relevant;

    const roomEncrypted = this.threadEncryption.isEncrypted(room);
    const unencryptedShield = unencryptedShieldFor(room, roomEncrypted);
    this._threadMessages.set(
      ordered.map((e) => {
        const id = e.getId() ?? '';
        const shown = shownSubject(e);
        const shield = unencryptedShield(e, shown) ?? shownShield(shown);
        // The room flag is in the key: it changes how a quoted reply and a poll read.
        const rev = `${eventRevision(client, room, e, roomEncrypted)}\x1f${shieldKey(shield)}\x1f${roomEncrypted}`;
        const cached = this.threadViewCache.get(id);
        if (cached && cached.rev === rev) {
          return cached.view; // unchanged — keep the object so its OnPush row is untouched
        }
        const view = projectMessage(
          client,
          room,
          e,
          shield,
          roomEncrypted,
          this.mediaPipeline,
        );
        if (!view) {
          // Thread timelines contain displayable message events only. A null here means an
          // SDK event was reclassified between filtering and projection; retain an explicit
          // fallback rather than leaking an absent row into the signal.
          throw new Error('Displayable thread event produced no presentation');
        }
        this.threadViewCache.set(id, { rev, view });
        return view;
      }),
    );
    // Prune replies no longer in the thread so the cache can't grow unbounded.
    for (const id of [...this.threadViewCache.keys()]) {
      if (!seenIds.has(id)) {
        this.threadViewCache.delete(id);
      }
    }
    // Resolve encrypted-message shields off the async crypto API; a change re-refreshes.
    void this.resolveThreadShields(room, false, ordered);

    // A thread's own live timeline carries a backward pagination token while older
    // replies remain server-side. Tuwunel also leaves one on a first /relations page that
    // already holds every reply, so the token alone would offer a Load older that finds
    // nothing. The server's reply count (`thread.length`) settles it. Edits are not
    // displayable replies and are not counted; a hidden event type keeps the button,
    // which is the safe side (a page that then finds nothing hides it, see paginateOpenThread).
    const timeline = thread?.liveTimeline ?? null;
    // A redacted reply lowers the server count, so it must not count as loaded either.
    const loadedReplies = ordered.filter(
      (e) => e.getId() !== rootEventId && !e.isRedacted(),
    ).length;
    this._canPaginateThread.set(
      this.exhaustedThreadRootId !== rootEventId &&
        timeline !== null &&
        timeline.getPaginationToken(Direction.Backward) !== null &&
        loadedReplies < (thread?.length ?? 0),
    );

    // The opened thread is being viewed, so mark its latest reply read (thread-scoped
    // receipt). Deduped, so paginating older history, which leaves the latest unchanged,
    // doesn't re-send.
    this.markThreadRead();
  }

  /** The opened thread's events, root first then replies (deduped). */
  private orderedThreadEvents(
    room: Room,
    rootEventId: string,
    thread: Thread | null = this.thread ?? room.getThread(rootEventId),
  ): MatrixEvent[] {
    const replies = (thread?.events ?? []).filter(isDisplayableMessage);
    const seen = new Set(replies.map((e) => e.getId()));
    const ordered: MatrixEvent[] = [];
    const root = thread?.rootEvent ?? room.findEventById(rootEventId);
    if (root && !seen.has(root.getId())) {
      ordered.push(root);
    }
    ordered.push(...replies);
    return ordered;
  }

  /**
   * Resolve authenticity shields for the opened thread's encrypted messages off the
   * async crypto API (identical rules to {@link TimelineService}), re-projecting the
   * thread once when any shield changes. `force` re-probes even already-resolved
   * events (a trust change); otherwise only new/undecrypted events are probed.
   */
  private async resolveThreadShields(
    room: Room,
    force: boolean,
    events?: readonly MatrixEvent[],
  ): Promise<void> {
    const rootEventId = this._openThreadRootId();
    const crypto = this.threadClient?.getCrypto?.() ?? null;
    if (!crypto || !rootEventId) {
      return;
    }
    // The crypto store may know the room is encrypted when its state does not say so.
    void this.threadEncryption
      .refresh(crypto, room.roomId)
      .then((roomEncrypted) => {
        if (roomEncrypted && this.threadRoomId === room.roomId) {
          this.refreshThread();
        }
      });
    const ordered = events ?? this.orderedThreadEvents(room, rootEventId);
    const encrypted = ordered.flatMap(shieldsToCheck);
    const fresh = !this.threadShieldsChecked;
    this.threadShieldsChecked = true;
    const changed = await resolveShieldsInto(
      crypto,
      encrypted,
      resolvedShields,
      {
        force: force || fresh,
        isStale: () => this.threadRoomId !== room.roomId,
      },
    );
    if (changed && this.threadRoomId === room.roomId) {
      this.refreshThread();
    }
  }

  /**
   * Send a thread-scoped read receipt for the opened thread's latest confirmed
   * event, clearing its unread badge, unless App lock covers the app. Best-effort: a
   * pending local echo is skipped (the SDK rejects a receipt on an unsent event) and any
   * missing/failed receipt API is swallowed so viewing a thread never throws.
   */
  private markThreadRead(): void {
    // Open, but nobody is looking at an unfocused window: hold the receipt so the thread
    // stays unread; onThreadFocus sends it for the latest reply when focus returns.
    if (!windowHasFocus()) {
      return;
    }
    const thread = this.thread;
    const key = this.conversationKey;
    const rootEventId = this._openThreadRootId();
    if (!thread || !key || !rootEventId) {
      return;
    }
    // Covered by App lock: nobody is looking; the attention effect re-acks after unlock.
    if (this.attention && !untracked(this.attention.attentive)) {
      return;
    }
    const latest = [...(thread.events ?? [])].reverse().find((e) => !e.status);
    const target = latest ?? thread.rootEvent ?? null;
    const id = target?.getId() ?? null;
    if (!target || !id || id === this.lastReadEventId) {
      return;
    }
    this.lastReadEventId = id;
    this.threadReceiptSubscription?.unsubscribe();
    this.threadReceiptSubscription = this.messageAdapter
      .acknowledge({ key, messageId: id, threadRootId: rootEventId })
      .subscribe((outcome) => {
        if (outcome.kind === 'rejected' && this.lastReadEventId === id) {
          this.lastReadEventId = null;
        }
      });
  }

  private summaryFor(
    client: MatrixClient,
    room: Room,
    thread: Thread,
    unencryptedShield: (
      event: MatrixEvent,
      subject?: MatrixEvent,
    ) => MessageShield | null,
  ): ThreadSummary {
    const root = thread.rootEvent ?? null;
    const rootTs = root?.getTs() ?? 0;
    let rootPreview: string | null = null;
    let rootSenderName: string | null = null;
    let rootShield: MessageShield | null = null;
    if (root) {
      // Each preview's shield marks unencrypted text, so the text itself stays readable.
      rootPreview = messagePreview(root, shownContent(root));
      rootShield = unencryptedShield(root, shownSubject(root));
      const sender = root.getSender() ?? '';
      rootSenderName = room.getMember(sender)?.name ?? sender;
    }

    const latest = thread.replyToEvent;
    let latestReplyTs: number | null = null;
    let latestReplyPreview: string | null = null;
    let latestReplySenderName: string | null = null;
    let latestReplyShield: MessageShield | null = null;
    // Only treat it as a "latest reply" when it isn't the root itself (the SDK
    // falls back to the root when every reply is redacted).
    if (latest && latest.getId() !== thread.id) {
      latestReplyTs = latest.getTs();
      latestReplyPreview = messagePreview(latest, shownContent(latest));
      latestReplyShield = unencryptedShield(latest, shownSubject(latest));
      const sender = latest.getSender() ?? '';
      latestReplySenderName = room.getMember(sender)?.name ?? sender;
    }

    const unread = threadUnread(room, thread.id);
    return {
      rootEventId: thread.id,
      rootPreview,
      rootSenderName,
      rootShield,
      replyCount: thread.length,
      latestReplyTs,
      latestActivityTs: latestReplyTs ?? rootTs,
      latestReplyPreview,
      latestReplySenderName,
      latestReplyShield,
      participants: participantsOf(room, thread),
      unreadCount: unread.count,
      highlight: unread.highlight,
    };
  }
}

/**
 * The send states of a thread echo, as `TimelineStore.sendStates` gives them for the room:
 * `null` once sent, complete once cancelled. Threads move onto the engine with PR 3.
 */
function echoSendStates(
  echo: MatrixEvent | undefined,
): Observable<SendState | null> {
  return new Observable((subscriber) => {
    if (!echo) return subscriber.complete();
    const emit = (): void => {
      const status = mapStatus(echo);
      if (echo.status === EventStatus.CANCELLED) subscriber.complete();
      else if (echo.status === EventStatus.SENT || echo.status === null)
        subscriber.next(null);
      else if (status === 'failed')
        subscriber.next({ kind: 'failed', recoverable: true });
      else subscriber.next({ kind: status ?? 'sending' });
    };
    emit();
    echo.on(MatrixEventEvent.Status, emit);
    return () => echo.off(MatrixEventEvent.Status, emit);
  });
}
