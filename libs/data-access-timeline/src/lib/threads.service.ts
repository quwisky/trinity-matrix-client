import { Injectable, computed, inject, signal } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import {
  Direction,
  EventType,
  MatrixEvent,
  MatrixEventEvent,
  NotificationCountType,
  ReceiptType,
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
  defer,
  finalize,
  from,
  map,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { MediaService } from '@trinity/data-access-media';
import { PrivacySettingsService } from '@trinity/platform-native';
import {
  buildMessageView,
  collectMessageSenders,
  initialOf,
  isDisplayableMessage,
  type MessageView,
} from '@trinity/util-matrix';
import {
  annotationContent,
  editMessageContent,
  mediaCaptionFields,
  messagePreview,
  myReactionId,
  renderMarkdown,
  replyMessageContent,
  textMessageContent,
  type Mention,
} from '@trinity/util-matrix';

/** A distinct participant of a thread, for compact avatar/name display. */
export interface ThreadParticipant {
  id: string;
  name: string;
  initial: string;
  avatarMxc: string | null;
}

/**
 * A compact, render-ready summary of a thread keyed by its root event — drives the
 * main-timeline "💬 N replies · last reply <time>" indicator. No SDK types leak out.
 */
export interface ThreadSummary {
  /** The event id of the thread root (the message the thread hangs off). */
  rootEventId: string;
  /** Short plain-text preview of the thread root, or null. */
  rootPreview: string | null;
  /** Display name of the thread root's sender, or null. */
  rootSenderName: string | null;
  /** Number of replies (excludes the root). */
  replyCount: number;
  /** Timestamp of the most recent reply, or null when not yet known. */
  latestReplyTs: number | null;
  /**
   * Timestamp of the thread's most recent activity — the latest reply, falling
   * back to the root's own timestamp. Always set, so it sorts a threads list
   * cleanly (newest first) even for a root that has no replies yet.
   */
  latestActivityTs: number;
  /** Short plain-text preview of the most recent reply, or null. */
  latestReplyPreview: string | null;
  /** Display name of the most recent reply's sender, or null. */
  latestReplySenderName: string | null;
  /** Distinct participants (capped) for an avatar cluster. */
  participants: ThreadParticipant[];
  /** Total unread notifications for this thread (0 when read / unknown). */
  unreadCount: number;
  /** Whether this thread has an unread highlight (mention/keyword). */
  highlight: boolean;
}

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
 *    *active* room, opened with {@link open}/{@link close}, feeding the main
 *    timeline's thread indicators.
 *  - {@link threadMessages}: the live, decrypted {@link MessageView}s of a *single*
 *    opened thread (root first, then replies), opened with {@link openThread}/
 *    {@link closeThread} when a thread view is presented.
 *
 * In-thread composing (send/reply/edit/delete/react) is layered on top via the
 * thread-scoped action methods below: each delegates to the same SDK calls the main
 * timeline uses, but passes the opened thread's root id as the `threadId` so the SDK
 * keeps the message in the thread (adding the `m.thread` relation for sends/replies)
 * and the optimistic local echo surfaces through {@link threadMessages}.
 */
@Injectable({ providedIn: 'root' })
export class ThreadsService {
  private readonly matrix = inject(MatrixClientService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly mediaSvc = inject(MediaService);
  private readonly privacy = inject(PrivacySettingsService);

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

  // --- Summaries (active room) ---------------------------------------------
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
  private threadRoom: Room | null = null;
  private threadRoomId: string | null = null;

  // User ids the opened thread renders a member for: each message's sender plus
  // each reply's quoted sender. Recomputed on every refresh; the member listener
  // re-maps only when one of these members loads/changes, so a lazy member-load
  // doesn't re-project the thread once per member.
  private threadRelevantSenders = new Set<string>();

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

  /** Start projecting a room's thread summaries; attaches live + decryption listeners. */
  open(roomId: string): void {
    if (this.summariesRoomId === roomId || !this.matrix.isInitialized) {
      return;
    }
    this.close();

    const client = this.matrix.instance;
    const room = client.getRoom(roomId);
    if (!room) {
      return;
    }

    this.summariesRoomId = roomId;
    this.summariesRoom = room;
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
    if (this.matrix.isInitialized) {
      this.matrix.instance.off(
        MatrixEventEvent.Decrypted,
        this.onSummariesDecrypted,
      );
    }
    this.summariesRoom = null;
    this.summariesRoomId = null;
    this.summaryCache.clear();
    this._summaries.set({});
  }

  /**
   * Open a single thread for viewing: project the root + its replies into
   * {@link threadMessages} and attach live + decryption listeners on the thread.
   */
  openThread(roomId: string, rootEventId: string): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    this.closeThread();

    const client = this.matrix.instance;
    const room = client.getRoom(roomId);
    if (!room) {
      return;
    }

    this.threadRoom = room;
    this.threadRoomId = roomId;
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
    client.on(MatrixEventEvent.Decrypted, this.onThreadDecrypted);
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
    }
    if (this.matrix.isInitialized) {
      this.matrix.instance.off(
        MatrixEventEvent.Decrypted,
        this.onThreadDecrypted,
      );
    }
    this.thread = null;
    this.threadRoom = null;
    this.threadRoomId = null;
    this.lastReadEventId = null;
    this.threadRelevantSenders.clear();
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
      !this.matrix.isInitialized
    ) {
      return of(void 0);
    }
    return defer(() => {
      this._loadingOlderThread.set(true);
      return from(
        // Resolved on subscribe: `instance` follows the active account.
        this.matrix.instance.paginateEventTimeline(timeline, {
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
   * Send a message into the opened thread. Markdown renders to sanitized HTML, like
   * the main composer. Passing the thread root as `threadId` makes the SDK add the
   * `m.thread` relation (`{ rel_type: 'm.thread', event_id, is_falling_back: true,
   * 'm.in_reply_to': { event_id: <latest reply ?? root> } }`) and route the echo
   * into the thread timeline. Encrypted rooms reuse the SDK's E2EE send path.
   */
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
    return from(
      this.matrix.instance.fetchRoomEvent(room.roomId, rootEventId),
    ).pipe(
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
      // Build the content so mentions carry `m.mentions` + matrix.to pills.
      const content = textMessageContent(
        text,
        renderMarkdown(this.sanitizer, text),
        mentions,
      );
      // Ensure a local Thread exists (fetching the root if needed) *before*
      // sending, so the threaded echo has a home; a fetch failure aborts the send.
      return this.ensureThread(room, threadId).pipe(
        switchMap(() =>
          from(client.sendMessage(roomId, threadId, content as never)),
        ),
      );
    }).pipe(map(() => void 0));
  }

  /**
   * Upload and send an attachment into the opened thread (encrypting the bytes first
   * in an E2EE room), reusing {@link MediaService}. `progress` reports an upload
   * fraction in [0, 1]; once sent, the SDK echo + retry path takes over.
   */
  sendMediaToThread(
    file: File,
    caption: string,
    progress?: (fraction: number) => void,
  ): Observable<void> {
    return defer(() => {
      const ctx = this.threadContext();
      if (!ctx || !file || file.size === 0) {
        return of(void 0);
      }
      const { client, room, roomId, threadId } = ctx;
      // Read on subscribe too: a room can become encrypted while an unsent action
      // is held, and uploading plaintext bytes into an E2EE room is not recoverable.
      const encrypt = room.hasEncryptionStateEvent();
      return this.mediaSvc.uploadMedia(file, encrypt, progress).pipe(
        switchMap((media) =>
          // Ensure the local Thread (fetching the root if needed) before sending,
          // so the media echo lands in the thread; a fetch failure aborts the send.
          this.ensureThread(room, threadId).pipe(
            switchMap(() => {
              const content = {
                msgtype: media.msgtype,
                ...mediaCaptionFields(this.sanitizer, media.body, caption),
                info: media.info,
                ...(media.file ? { file: media.file } : { url: media.mxc }),
              };
              // A valid media payload; the SDK's content union doesn't model it.
              return from(
                client.sendMessage(roomId, threadId, content as never),
              );
            }),
          ),
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
        renderMarkdown(this.sanitizer, text),
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
        renderMarkdown(this.sanitizer, text),
        mentions,
      );
      return from(client.sendMessage(roomId, threadId, content as never));
    }).pipe(map(() => void 0));
  }

  /** Delete (redact) a message in the thread. */
  redactInThread(messageId: string): Observable<void> {
    return defer(() => {
      const ctx = this.threadContext();
      if (!ctx) {
        return of(void 0);
      }
      const { client, roomId, threadId } = ctx;
      return from(client.redactEvent(roomId, threadId, messageId));
    }).pipe(map(() => void 0));
  }

  /**
   * Toggle the current user's reaction to a thread message: add the `m.annotation`
   * if absent, else redact their existing one. Reactions aggregate on the room's
   * relations (no thread rel_type), but the echo is routed via `threadId`.
   */
  toggleReactionInThread(messageId: string, key: string): Observable<void> {
    return defer(() => {
      const ctx = this.threadContext();
      if (!ctx) {
        return of(void 0);
      }
      const { client, room, roomId, threadId } = ctx;
      const mine = myReactionId(client, room, messageId, key);
      if (mine) {
        return from(client.redactEvent(roomId, threadId, mine));
      }
      return from(
        client.sendEvent(
          roomId,
          threadId,
          EventType.Reaction,
          annotationContent(messageId, key) as never,
        ),
      );
    }).pipe(map(() => void 0));
  }

  /** Resend a thread message that failed to send. */
  retryInThread(messageId: string): void {
    const ctx = this.threadContext();
    if (!ctx) {
      return;
    }
    const { client, room } = ctx;
    const event =
      this.thread?.events.find((e) => e.getId() === messageId) ??
      room.findEventById(messageId);
    if (event) {
      client.resendEvent(event, room).catch(() => undefined);
    }
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
    if (!room || !threadId || !this.matrix.isInitialized) {
      return null;
    }
    return {
      client: this.matrix.instance,
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
    const client = this.matrix.instance;
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
    const client = this.matrix.instance;
    const thread = this.thread ?? room.getThread(rootEventId);

    // Replies live in the thread timeline; the root sits at the top. Dedupe so a
    // root already present in the thread timeline isn't repeated.
    const replies = (thread?.events ?? []).filter(isDisplayableMessage);
    const seen = new Set(replies.map((e) => e.getId()));
    const ordered: MatrixEvent[] = [];
    const root = thread?.rootEvent ?? room.findEventById(rootEventId);
    if (root && !seen.has(root.getId())) {
      ordered.push(root);
    }
    ordered.push(...replies);

    const relevant = new Set<string>();
    for (const e of ordered) {
      collectMessageSenders(room, e, relevant);
    }
    this.threadRelevantSenders = relevant;

    this._threadMessages.set(
      ordered.map((e) => buildMessageView(client, room, e)),
    );

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

  /**
   * Send a thread-scoped read receipt for the opened thread's latest confirmed
   * event, clearing its unread badge. Best-effort: a pending local echo is skipped
   * (the SDK rejects a receipt on an unsent event) and any missing/failed receipt
   * API is swallowed so viewing a thread never throws.
   */
  private markThreadRead(): void {
    const thread = this.thread;
    if (!thread || !this.matrix.isInitialized) {
      return;
    }
    const latest = [...(thread.events ?? [])].reverse().find((e) => !e.status);
    const target = latest ?? thread.rootEvent ?? null;
    const id = target?.getId() ?? null;
    if (!target || !id || id === this.lastReadEventId) {
      return;
    }
    this.lastReadEventId = id;
    try {
      // The event carries its thread id, so the SDK scopes the receipt to the
      // thread (rather than the main timeline) automatically. Respect the read-
      // receipt privacy toggle: send privately (`m.read.private`) when it's off.
      const receiptType = this.privacy.sendReadReceipts()
        ? ReceiptType.Read
        : ReceiptType.ReadPrivate;
      void this.matrix.instance
        .sendReadReceipt(target, receiptType)
        ?.catch(() => undefined);
    } catch {
      // A missing/unsupported receipt API must never break thread viewing.
    }
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
