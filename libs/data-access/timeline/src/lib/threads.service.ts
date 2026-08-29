import { Injectable, computed, inject, signal } from '@angular/core';
import {
  Direction,
  MatrixEvent,
  MatrixEventEvent,
  NotificationCountType,
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
  defer,
  finalize,
  from,
  map,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { MediaPipeline } from '@trinity/data-access/media';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import {
  collectMessageSenders,
  initialOf,
  isDisplayableMessage,
} from '@trinity/util/matrix';
import { resolveShieldsInto, shieldKey } from './shields';
import { eventRevision } from './timeline.service';
import { projectMessage } from './project-message';
import type { MessageShield, MessageView } from './message-presentation';
import type { ConversationKey } from './conversation-messages';
import { CONVERSATION_MESSAGE_ADAPTER } from './conversation-message-adapter.service';
import type { ThreadParticipant, ThreadSummary } from './conversation-threads';
import {
  editMessageContent,
  messagePreview,
  renderMarkdown,
  replyMessageContent,
  slashCommandContent,
  textMessageContent,
  type Mention,
} from '@trinity/util/matrix';

/** Most participant avatars shown in a summary cluster before "+N". */
const MAX_PARTICIPANTS = 8;

/** Older thread replies pulled in per backward-pagination round. */
const THREAD_SCROLLBACK = 30;

/**
 * Projects a room's threads into render-ready signals — mirroring
 * {@link TimelineService}'s shape (instance-keyed connect/disconnect, defensive
 * event handlers, async-decryption re-mapping). Two independent views:
 *
 *  - {@link summaries}: a map of thread-root id → {@link ThreadSummary} for the
 *    exact room, bound with {@link attach}/{@link close}, feeding the main
 *    timeline's thread indicators.
 *  - {@link threadMessages}: the live, decrypted {@link MessageView}s of a *single*
 *    opened thread (root first, then replies), bound with
 *    {@link attachThreadRoot}/{@link closeThread} when a thread view is presented.
 *
 * Text send/reply/edit are the package-internal SDK adapter for the public exact-root
 * child. Message relations and staged media use the shared Conversation adapters, so
 * no second public action facade can drift from the room path.
 */
@Injectable()
export class ThreadsService {
  private readonly mediaPipeline = inject(MediaPipeline);
  private readonly messageAdapter = inject(CONVERSATION_MESSAGE_ADAPTER);
  private conversationKey: ConversationKey | null = null;

  private readonly _summaries = signal<Record<string, ThreadSummary>>({});
  /** Thread summaries for the active room, keyed by thread-root event id. */
  readonly summaries = this._summaries.asReadonly();

  /**
   * The active room's threads as a flat list, newest activity first — drives the
   * threads-list panel. Derived from {@link summaries}, so it reacts to new
   * threads, replies, and unread changes without a separate projection.
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

  // --- Summaries (active room) ---------------------------------------------
  /**
   * The exact Account client {@link attach} bound. Re-reading a mutable active pointer
   * on close would detach from the new client and leak this listener on the old one.
   */
  private summariesClient: MatrixClient | null = null;
  private summariesRoom: Room | null = null;
  private summariesRoomId: string | null = null;

  // Per-thread summary cache keyed by thread-root id. Each entry stores the summary
  // and a `rev` fingerprint of everything {@link summaryFor} reads that can change
  // (reply count, root/latest reply, unread counts — see {@link threadSummaryRevision}).
  // A summary is rebuilt only when its fingerprint changes, so a message in one
  // thread no longer rebuilds every other thread's summary — and unchanged
  // thread-root rows keep their object identity and aren't re-rendered.
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
  // A summary renders each participant's name + avatar (and the root/latest sender
  // names), all resolved from room membership — which can arrive (lazy loading) or
  // change after the summary was built. The revision fingerprint deliberately does
  // NOT walk participant avatars (that would cost a member scan on every refresh),
  // so instead drop the summaries the changed member takes part in and let
  // refreshSummaries rebuild just those with the resolved profile. The cached
  // participant list is the gate: an unreferenced member matches nothing and no
  // rebuild happens.
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
  /** The exact Account client {@link attachThreadRoot} inherited — see {@link summariesClient}. */
  private threadClient: MatrixClient | null = null;
  private threadRoom: Room | null = null;
  private threadRoomId: string | null = null;

  // User ids the opened thread renders a member for: each message's sender plus
  // each reply's quoted sender. Recomputed on every refresh; the member listener
  // re-maps only when one of these members loads/changes, so a lazy member-load
  // doesn't re-project the thread once per member.
  private threadRelevantSenders = new Set<string>();

  /** Resolved authenticity shields for the opened thread's events, by event id. */
  private readonly threadShields = new Map<string, MessageShield | null>();
  /**
   * Per-reply projection cache keyed by event id, mirroring TimelineService.viewCache:
   * `rev` fingerprints everything Message Presentation reads that can change while the
   * thread is open (the shield folded in, since it resolves asynchronously). Without it
   * every refresh re-ran a markdown render + DOMPurify sanitize for EVERY reply — and
   * refreshThread is driven by Timeline/LocalEcho/Decrypted/Members, so a keystroke
   * echo rebuilt the whole thread and handed every OnPush row a new identity.
   */
  private threadViewCache = new Map<
    string,
    { rev: string; view: MessageView }
  >();

  // Cross-signing / device trust changed: a thread message's shield may flip, so
  // force a full re-resolve of the opened thread's shields (mirrors TimelineService).
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
  // A quoted sender's name/avatar can arrive after its reply (lazy loading),
  // otherwise leaving the in-thread reply preview stuck on the raw mxid + initials.
  // Re-map when a member the thread actually references loads or changes.
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
  // A thread can be created by our own first in-thread reply: bind to it lazily so
  // the optimistic echo (and later replies) flow into the view.
  private readonly onThreadCreated = (thread: Thread): void => {
    if (!this.thread && thread.id === this._openThreadRootId()) {
      this.attachThread(thread);
    }
    this.refreshThread();
  };

  resources(): { listenerCount: number; retainedBytes: number } {
    const summaryListeners = this.summariesRoom ? 7 : 0;
    const summaryClientListeners = this.summariesClient ? 1 : 0;
    const threadRoomListeners = this.threadRoom ? 4 : 0;
    const threadClientListeners = this.threadClient ? 4 : 0;
    const threadListeners = this.thread ? 3 : 0;
    return {
      listenerCount:
        summaryListeners +
        summaryClientListeners +
        threadRoomListeners +
        threadClientListeners +
        threadListeners,
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
    // Attach an already-aggregated Thread (e.g. opening from a "N replies"
    // indicator). When none exists — opening a *new* thread via "Reply in thread"
    // on a plain message — leave the view root-only and do NOT create a Thread yet:
    // creating one on open would leave an empty 0-reply thread if the user never
    // sends. The Thread is created lazily on the first send (see `ensureThread`),
    // and `ThreadEvent.New` still attaches it if a remote reply forms it meanwhile.
    const thread = room.getThread(rootEventId);
    if (thread) {
      this.attachThread(thread);
    }
    // New replies + reply-count changes arrive on the thread; the local echo's
    // send-status transitions (sending → sent/failed) arrive at the room level, so
    // listen there too to re-map the optimistic echo just like the main timeline.
    room.on(ThreadEvent.New, this.onThreadCreated);
    room.on(RoomEvent.LocalEchoUpdated, this.onThreadChanged);
    room.on(RoomStateEvent.Members, this.onThreadMember);
    // A reply's "seen by" avatars follow the read markers, and a receipt is none of the
    // thread-level events above — the summaries projection binds this for the same
    // reason, and the main timeline does too (timeline.service.ts). Without it a
    // receipt only surfaced when some unrelated event happened to re-refresh.
    room.on(RoomEvent.Receipt, this.onThreadChanged);
    client.on(MatrixEventEvent.Decrypted, this.onThreadDecrypted);
    client.on(CryptoEvent.UserTrustStatusChanged, this.onThreadTrust);
    client.on(CryptoEvent.DevicesUpdated, this.onThreadTrust);
    client.on(CryptoEvent.KeysChanged, this.onThreadTrust);
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
    this.threadRoom = null;
    this.threadRoomId = null;
    this.threadReceiptSubscription?.unsubscribe();
    this.threadReceiptSubscription = null;
    this.lastReadEventId = null;
    this.threadRelevantSenders.clear();
    this.threadShields.clear();
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
   * Page in older replies for the opened thread (backward pagination over the
   * thread's own live timeline), mirroring {@link TimelineService.loadOlder}. A
   * `Thread` owns a {@link EventTimeline} via `thread.liveTimeline`; paginating it
   * backwards prepends older replies, which are re-mapped into
   * {@link threadMessages} exactly like the live path. The `loadingOlder` flag is
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
    return defer(() => {
      const client = this.threadClient;
      if (!client || this.thread !== thread) return of(void 0);
      this._loadingOlderThread.set(true);
      return from(
        client.paginateEventTimeline(timeline, {
          backwards: true,
          limit: THREAD_SCROLLBACK,
        }),
      );
    }).pipe(
      tap(() => this.refreshThread()),
      finalize(() => this._loadingOlderThread.set(false)),
      map(() => void 0),
    );
  }

  // --- In-thread composing --------------------------------------------------
  // Each action mirrors the matching TimelineService method (sharing the content
  // builders in message-content.ts) but passes the opened thread's root id as the
  // SDK `threadId`, so the message stays in the thread and its optimistic echo +
  // failed/retry state surface through `threadMessages` exactly like the timeline.

  /**
   * Create + attach the Thread just before the first reply is sent, if one doesn't
   * exist yet. matrix-js-sdk doesn't form a Thread from the sender's own first reply
   * — the echo is treated as threaded (so it's kept out of the main timeline) but no
   * Thread is created, so the reply would vanish. Creating it here, only when the user
   * actually sends, gives the reply a home without leaving an empty 0-reply thread
   * when a thread is merely opened then abandoned. No-op once attached/aggregated.
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
    // The root isn't in memory (e.g. an old thread that scrolled out of the live
    // timeline). The SDK would still route a threaded send out, but with no local
    // Thread the optimistic echo has nowhere to land and vanishes. Fetch the root
    // so the Thread can be created; if it can't be fetched, surface the error
    // rather than sending a reply that won't show.
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
      const { client, room, roomId, threadId } = ctx;
      // A leading slash command (/me, /shrug, /plain, /spoiler) rewrites the content
      // just like the main composer; otherwise build the normal text content so
      // mentions carry `m.mentions` + matrix.to pills.
      const content =
        slashCommandContent(text, renderMarkdown, mentions) ??
        textMessageContent(text, renderMarkdown(text), mentions);
      // Ensure a local Thread exists (fetching the root if needed) *before*
      // sending, so the threaded echo has a home; a fetch failure aborts the send.
      return this.ensureThread(room, threadId).pipe(
        switchMap(() =>
          from(client.sendMessage(roomId, threadId, content as never)),
        ),
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
        renderMarkdown(text),
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
      const { client, room, roomId, threadId } = ctx;
      const content = replyMessageContent(
        room,
        messageId,
        text,
        renderMarkdown(text),
        mentions,
      );
      return from(client.sendMessage(roomId, threadId, content as never));
    }).pipe(map(() => void 0));
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
    for (const thread of room.getThreads()) {
      const id = thread.id;
      seen.add(id);
      // Reuse the cached summary (preserving its identity) unless this thread's
      // fingerprint changed; only the affected thread is rebuilt + merged in.
      const rev = threadSummaryRevision(room, thread);
      const cached = this.summaryCache.get(id);
      if (cached && cached.rev === rev) {
        summaries[id] = cached.summary;
        continue;
      }
      const summary = this.summaryFor(client, room, thread);
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
    // Drop shields for events no longer in the thread so the map can't grow unbounded.
    for (const id of [...this.threadShields.keys()]) {
      if (!seenIds.has(id)) {
        this.threadShields.delete(id);
      }
    }

    this._threadMessages.set(
      ordered.map((e) => {
        const id = e.getId() ?? '';
        const shield = this.threadShields.get(id) ?? null;
        const rev = eventRevision(client, room, e) + '\x1f' + shieldKey(shield);
        const cached = this.threadViewCache.get(id);
        if (cached && cached.rev === rev) {
          return cached.view; // unchanged — keep the object so its OnPush row is untouched
        }
        const view = projectMessage(
          client,
          room,
          e,
          shield,
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

    // A thread's own live timeline carries a backward pagination token while
    // older replies remain server-side; absent (or no timeline) means none left.
    const timeline = thread?.liveTimeline ?? null;
    this._canPaginateThread.set(
      timeline
        ? timeline.getPaginationToken(Direction.Backward) !== null
        : false,
    );

    // The opened thread is being viewed, so mark its latest reply read (a
    // thread-scoped receipt). Deduped, so live replies mark read but paginating
    // older history — which leaves the latest unchanged — does not re-send.
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
    const ordered = events ?? this.orderedThreadEvents(room, rootEventId);
    const encrypted = ordered.filter((e) => e.isEncrypted());
    const changed = await resolveShieldsInto(
      crypto,
      encrypted,
      this.threadShields,
      { force, isStale: () => this.threadRoomId !== room.roomId },
    );
    if (changed && this.threadRoomId === room.roomId) {
      this.refreshThread();
    }
  }

  /**
   * Send a thread-scoped read receipt for the opened thread's latest confirmed
   * event, clearing its unread badge. Best-effort: a pending local echo is skipped
   * (the SDK rejects a receipt on an unsent event) and any missing/failed receipt
   * API is swallowed so viewing a thread never throws.
   */
  private markThreadRead(): void {
    const thread = this.thread;
    const key = this.conversationKey;
    const rootEventId = this._openThreadRootId();
    if (!thread || !key || !rootEventId) {
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
  ): ThreadSummary {
    const root = thread.rootEvent ?? null;
    const rootTs = root?.getTs() ?? 0;
    let rootPreview: string | null = null;
    let rootSenderName: string | null = null;
    if (root) {
      rootPreview = messagePreview(root);
      const sender = root.getSender() ?? '';
      rootSenderName = room.getMember(sender)?.name ?? sender;
    }

    const latest = thread.replyToEvent;
    let latestReplyTs: number | null = null;
    let latestReplyPreview: string | null = null;
    let latestReplySenderName: string | null = null;
    // Only treat it as a "latest reply" when it isn't the root itself (the SDK
    // falls back to the root when every reply is redacted).
    if (latest && latest.getId() !== thread.id) {
      latestReplyTs = latest.getTs();
      latestReplyPreview = messagePreview(latest);
      const sender = latest.getSender() ?? '';
      latestReplySenderName = room.getMember(sender)?.name ?? sender;
    }

    const unread = threadUnread(room, thread.id);
    return {
      rootEventId: thread.id,
      rootPreview,
      rootSenderName,
      replyCount: thread.length,
      latestReplyTs,
      latestActivityTs: latestReplyTs ?? rootTs,
      latestReplyPreview,
      latestReplySenderName,
      participants: participantsOf(room, thread),
      unreadCount: unread.count,
      highlight: unread.highlight,
    };
  }
}

/**
 * A compact fingerprint of every input {@link ThreadsService.summaryFor} reads
 * that can change for a thread: its reply count (which also tracks new
 * participants), its root and latest-reply events (id/timestamp/redaction/
 * decryption/body/sender + resolved name, so edits and redactions are caught), and
 * its unread counts. The summary is rebuilt only when this changes.
 */
function threadSummaryRevision(room: Room, thread: Thread): string {
  const latest = thread.replyToEvent;
  const unread = threadUnread(room, thread.id);
  return [
    thread.id,
    String(thread.length),
    threadEventSignature(room, thread.rootEvent ?? null),
    // The SDK falls back to the root when every reply is redacted; mirror
    // summaryFor and treat that as "no latest reply".
    latest && latest.getId() !== thread.id
      ? threadEventSignature(room, latest)
      : '',
    String(unread.count),
    unread.highlight ? '1' : '0',
  ].join('\x1f');
}

/** Signature of a thread root/reply event for {@link threadSummaryRevision}. */
function threadEventSignature(room: Room, event: MatrixEvent | null): string {
  if (!event) {
    return '';
  }
  const sender = event.getSender() ?? '';
  return [
    event.getId() ?? '',
    String(event.getTs()),
    event.isRedacted() ? 'r' : '',
    event.isDecryptionFailure() ? 'd' : '',
    String(event.getContent()['body'] ?? ''),
    sender,
    room.getMember(sender)?.name ?? sender,
  ].join('\x02');
}

/**
 * A thread's unread notification counts, defensively read. A server/SDK that
 * doesn't expose per-thread counts (older homeserver, missing API) must yield a
 * read state rather than throw.
 */
function threadUnread(
  room: Room,
  threadId: string,
): { count: number; highlight: boolean } {
  try {
    const total = room.getThreadUnreadNotificationCount(
      threadId,
      NotificationCountType.Total,
    );
    const highlight = room.getThreadUnreadNotificationCount(
      threadId,
      NotificationCountType.Highlight,
    );
    return { count: total, highlight: highlight > 0 };
  } catch {
    return { count: 0, highlight: false };
  }
}

/** Distinct senders of a thread's loaded events (root + replies), capped. */
function participantsOf(room: Room, thread: Thread): ThreadParticipant[] {
  const participants: ThreadParticipant[] = [];
  const seen = new Set<string>();
  const events = [
    ...(thread.rootEvent ? [thread.rootEvent] : []),
    ...thread.events,
  ];
  for (const event of events) {
    const id = event.getSender();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const member = room.getMember(id);
    const name = member?.name ?? id;
    participants.push({
      id,
      name,
      initial: initialOf(name),
      avatarMxc: member?.getMxcAvatarUrl() ?? null,
    });
    if (participants.length >= MAX_PARTICIPANTS) {
      break;
    }
  }
  return participants;
}
