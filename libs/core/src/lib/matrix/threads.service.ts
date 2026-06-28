import { Injectable, inject, signal } from '@angular/core';
import {
  MatrixEventEvent,
  RoomEvent,
  ThreadEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type Thread,
} from 'matrix-js-sdk';
import { MatrixClientService } from './matrix-client.service';
import {
  buildMessageView,
  initialOf,
  isDisplayableMessage,
  stripReplyFallbackText,
  type MessageView,
} from './message-view';

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
  /** Number of replies (excludes the root). */
  replyCount: number;
  /** Timestamp of the most recent reply, or null when not yet known. */
  latestReplyTs: number | null;
  /** Short plain-text preview of the most recent reply, or null. */
  latestReplyPreview: string | null;
  /** Display name of the most recent reply's sender, or null. */
  latestReplySenderName: string | null;
  /** Distinct participants (capped) for an avatar cluster. */
  participants: ThreadParticipant[];
}

/** Most participant avatars shown in a summary cluster before "+N". */
const MAX_PARTICIPANTS = 8;

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
 * Read-only for now (no in-thread composing); the open-thread shape is structured so
 * a thread composer can be layered on next, the way compose followed timeline-read.
 */
@Injectable({ providedIn: 'root' })
export class ThreadsService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _summaries = signal<Record<string, ThreadSummary>>({});
  /** Thread summaries for the active room, keyed by thread-root event id. */
  readonly summaries = this._summaries.asReadonly();

  private readonly _threadMessages = signal<MessageView[]>([]);
  /** Live, decrypted messages of the opened thread (root first, then replies). */
  readonly threadMessages = this._threadMessages.asReadonly();

  private readonly _openThreadRootId = signal<string | null>(null);
  /** The root event id of the currently opened thread, or null. */
  readonly openThreadRootId = this._openThreadRootId.asReadonly();

  // --- Summaries (active room) ---------------------------------------------
  private summariesRoom: Room | null = null;
  private summariesRoomId: string | null = null;

  private readonly onSummariesChanged = (): void => this.refreshSummaries();
  private readonly onSummariesDecrypted = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.summariesRoomId) {
      this.refreshSummaries();
    }
  };

  // --- Opened thread --------------------------------------------------------
  private thread: Thread | null = null;
  private threadRoom: Room | null = null;
  private threadRoomId: string | null = null;

  private readonly onThreadChanged = (): void => this.refreshThread();
  private readonly onThreadDecrypted = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.threadRoomId) {
      this.refreshThread();
    }
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
    }
    if (this.matrix.isInitialized) {
      this.matrix.instance.off(
        MatrixEventEvent.Decrypted,
        this.onSummariesDecrypted,
      );
    }
    this.summariesRoom = null;
    this.summariesRoomId = null;
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
    // `getThread` returns the existing Thread when the indicator that launched this
    // is showing (the SDK has already aggregated it). If absent, fall through to a
    // root-only view rather than throwing.
    const thread = room.getThread(rootEventId);
    if (thread) {
      this.thread = thread;
      thread.on(ThreadEvent.Update, this.onThreadChanged);
      thread.on(ThreadEvent.NewReply, this.onThreadChanged);
      thread.on(RoomEvent.Timeline, this.onThreadChanged);
    }
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
    if (this.matrix.isInitialized) {
      this.matrix.instance.off(
        MatrixEventEvent.Decrypted,
        this.onThreadDecrypted,
      );
    }
    this.thread = null;
    this.threadRoom = null;
    this.threadRoomId = null;
    this._openThreadRootId.set(null);
    this._threadMessages.set([]);
  }

  private refreshSummaries(): void {
    const room = this.summariesRoom;
    if (!room) {
      return;
    }
    const client = this.matrix.instance;
    const summaries: Record<string, ThreadSummary> = {};
    for (const thread of room.getThreads()) {
      summaries[thread.id] = this.summaryFor(client, room, thread);
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

    this._threadMessages.set(
      ordered.map((e) => buildMessageView(client, room, e)),
    );
  }

  private summaryFor(
    client: MatrixClient,
    room: Room,
    thread: Thread,
  ): ThreadSummary {
    const latest = thread.replyToEvent;
    let latestReplyTs: number | null = null;
    let latestReplyPreview: string | null = null;
    let latestReplySenderName: string | null = null;
    // Only treat it as a "latest reply" when it isn't the root itself (the SDK
    // falls back to the root when every reply is redacted).
    if (latest && latest.getId() !== thread.id) {
      latestReplyTs = latest.getTs();
      latestReplyPreview = previewText(latest);
      const sender = latest.getSender() ?? '';
      latestReplySenderName = room.getMember(sender)?.name ?? sender;
    }
    return {
      rootEventId: thread.id,
      replyCount: thread.length,
      latestReplyTs,
      latestReplyPreview,
      latestReplySenderName,
      participants: participantsOf(room, thread),
    };
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

/** Short, single-line preview of a reply for the thread indicator. */
function previewText(event: MatrixEvent): string {
  if (event.isDecryptionFailure()) {
    return '⚠️ Unable to decrypt';
  }
  if (event.isRedacted()) {
    return '(message deleted)';
  }
  const content = event.getContent();
  const body = stripReplyFallbackText((content['body'] as string) ?? '');
  return body.replace(/\s+/g, ' ').trim() || '…';
}
