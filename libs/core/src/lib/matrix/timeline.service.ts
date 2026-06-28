import { Injectable, inject, signal } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import {
  Direction,
  EventType,
  MatrixEventEvent,
  RoomEvent,
  type MatrixEvent,
  type Room,
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
import { MatrixClientService } from './matrix-client.service';
import { MediaService } from './media.service';
import {
  buildMessageView,
  isDisplayableMessage,
  type MessageView,
} from './message-view';
import {
  annotationContent,
  editMessageContent,
  myReactionId,
  renderMarkdown,
  replyMessageContent,
} from './message-content';

// Re-export the message view model + reaction/reply types from their shared home
// so existing `@trinity/core` consumers (and the timeline barrel entry) are
// unaffected by the extraction into message-view.ts.
export type {
  MessageKind,
  MessageView,
  ReactionView,
  ReplyPreview,
} from './message-view';

const SCROLLBACK = 30;

/**
 * Projects the *active* room's live timeline into a `messages` signal of view
 * models. Re-maps on new events and on async E2EE decryption. The shell opens one
 * room at a time; `matrix-js-sdk` remains the source of truth.
 *
 * With thread support enabled on the client (see {@link MatrixClientService}), the
 * SDK routes threaded replies into per-thread timelines, so they are absent from
 * the room's live timeline here — only thread *roots* remain in the main view. The
 * thread roots and their replies are projected separately by `ThreadsService`.
 */
@Injectable({ providedIn: 'root' })
export class TimelineService {
  private readonly matrix = inject(MatrixClientService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly mediaSvc = inject(MediaService);

  private readonly _messages = signal<MessageView[]>([]);
  readonly messages = this._messages.asReadonly();

  private readonly _loadingOlder = signal(false);
  readonly loadingOlder = this._loadingOlder.asReadonly();

  private readonly _canLoadOlder = signal(false);
  readonly canLoadOlder = this._canLoadOlder.asReadonly();

  private roomId: string | null = null;
  private room: Room | null = null;

  // Latest event we've already sent a read receipt for, so live messages while
  // the room is open mark read without re-sending on every refresh — and
  // pagination/backfill (which leaves the latest unchanged) doesn't re-ack.
  private lastReadEventId: string | null = null;

  private readonly onTimeline = (): void => this.refresh();
  private readonly onLocalEcho = (): void => this.refresh();
  private readonly onDecrypted = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.roomId) {
      this.refresh();
    }
  };

  /** Start projecting a room's live timeline; attaches live + decryption listeners. */
  open(roomId: string): void {
    if (this.roomId === roomId || !this.matrix.isInitialized) {
      return;
    }
    this.close();

    const client = this.matrix.instance;
    const room = client.getRoom(roomId);
    if (!room) {
      return;
    }

    this.roomId = roomId;
    this.room = room;
    room.on(RoomEvent.Timeline, this.onTimeline);
    room.on(RoomEvent.LocalEchoUpdated, this.onLocalEcho);
    client.on(MatrixEventEvent.Decrypted, this.onDecrypted);
    // Projects the timeline and sends the initial read receipt; subsequent live
    // messages re-ack through the same path (see {@link markRead}).
    this.refresh();
  }

  /** Detach listeners and clear the timeline. */
  close(): void {
    this.room?.off(RoomEvent.Timeline, this.onTimeline);
    this.room?.off(RoomEvent.LocalEchoUpdated, this.onLocalEcho);
    if (this.matrix.isInitialized) {
      this.matrix.instance.off(MatrixEventEvent.Decrypted, this.onDecrypted);
    }
    this.room = null;
    this.roomId = null;
    this.lastReadEventId = null;
    this._messages.set([]);
    this._canLoadOlder.set(false);
  }

  /** Page in older history (backward pagination via `scrollback`). */
  loadOlder(): Observable<void> {
    const room = this.room;
    if (!room || this._loadingOlder()) {
      return of(void 0);
    }
    return defer(() => {
      this._loadingOlder.set(true);
      return from(this.matrix.instance.scrollback(room, SCROLLBACK));
    }).pipe(
      tap(() => this.refresh()),
      // Reset the flag on success *or* error — otherwise a failed scrollback
      // would leave it stuck true and permanently disable pagination.
      finalize(() => this._loadingOlder.set(false)),
      map(() => void 0),
    );
  }

  /**
   * Send a message to the active room. Markdown is rendered to HTML, sanitized,
   * and sent as `formatted_body` — but only when it actually adds formatting; plain
   * text is sent as-is. The local echo appears via the timeline listener.
   */
  send(body: string): Observable<void> {
    const room = this.room;
    const text = body.trim();
    if (!room || !text || !this.matrix.isInitialized) {
      return of(void 0);
    }
    const client = this.matrix.instance;
    return defer(() => {
      const md = renderMarkdown(this.sanitizer, text);
      return from(
        md.formatted
          ? client.sendHtmlMessage(room.roomId, text, md.html)
          : client.sendTextMessage(room.roomId, text),
      );
    }).pipe(map(() => void 0));
  }

  /**
   * Upload a picked file and send it as an `m.image`/`m.file`/`m.video`/`m.audio`
   * message — encrypting the bytes first when the room is E2EE. The upload phase has
   * no echo (failures surface via this Observable); once `sendMessage` runs the SDK
   * creates a local echo that renders through the existing media bubble, with the
   * usual failed/retry handling. `progress` reports an upload fraction in [0, 1].
   */
  sendMedia(
    file: File,
    progress?: (fraction: number) => void,
  ): Observable<void> {
    const room = this.room;
    if (!room || !this.matrix.isInitialized || !file || file.size === 0) {
      return of(void 0);
    }
    const client = this.matrix.instance;
    const encrypt = room.hasEncryptionStateEvent();
    return defer(() => this.mediaSvc.uploadMedia(file, encrypt, progress)).pipe(
      switchMap((media) => {
        const content = {
          msgtype: media.msgtype,
          body: media.body,
          info: media.info,
          ...(media.file ? { file: media.file } : { url: media.mxc }),
        };
        // A valid media payload; the SDK's content union doesn't model it.
        return from(client.sendMessage(room.roomId, content as never));
      }),
      map(() => void 0),
    );
  }

  /** Edit a previously-sent message via an `m.replace` relation. */
  edit(messageId: string, newBody: string): Observable<void> {
    const room = this.room;
    const text = newBody.trim();
    if (!room || !text || !this.matrix.isInitialized) {
      return of(void 0);
    }
    const client = this.matrix.instance;
    return defer(() => {
      const content = editMessageContent(
        messageId,
        text,
        renderMarkdown(this.sanitizer, text),
      );
      // `content` is a valid m.replace payload; the SDK's content union doesn't
      // model it, so assert past it.
      return from(client.sendMessage(room.roomId, content as never));
    }).pipe(map(() => void 0));
  }

  /** Resend a message that failed to send. */
  retry(messageId: string): void {
    const room = this.room;
    if (!room || !this.matrix.isInitialized) {
      return;
    }
    const event = room
      .getLiveTimeline()
      .getEvents()
      .find((e) => e.getId() === messageId);
    if (event) {
      this.matrix.instance.resendEvent(event, room).catch(() => undefined);
    }
  }

  /** Send a reply to a message (`m.in_reply_to`), with a plain-text quote fallback. */
  reply(messageId: string, body: string): Observable<void> {
    const room = this.room;
    const text = body.trim();
    if (!room || !text || !this.matrix.isInitialized) {
      return of(void 0);
    }
    const client = this.matrix.instance;
    return defer(() => {
      const content = replyMessageContent(
        room,
        messageId,
        text,
        renderMarkdown(this.sanitizer, text),
      );
      return from(client.sendMessage(room.roomId, content as never));
    }).pipe(map(() => void 0));
  }

  /** Delete (redact) a message. */
  redact(messageId: string): Observable<void> {
    const room = this.room;
    if (!room || !this.matrix.isInitialized) {
      return of(void 0);
    }
    const client = this.matrix.instance;
    return defer(() => from(client.redactEvent(room.roomId, messageId))).pipe(
      map(() => void 0),
    );
  }

  /**
   * Toggle the current user's reaction to a message: add the `m.annotation` if it
   * isn't there yet, otherwise redact their existing one.
   */
  toggleReaction(messageId: string, key: string): Observable<void> {
    const room = this.room;
    if (!room || !this.matrix.isInitialized) {
      return of(void 0);
    }
    const client = this.matrix.instance;
    return defer(() => {
      const mine = myReactionId(client, room, messageId, key);
      if (mine) {
        return from(client.redactEvent(room.roomId, mine));
      }
      return from(
        client.sendEvent(
          room.roomId,
          EventType.Reaction,
          annotationContent(messageId, key) as never,
        ),
      );
    }).pipe(map(() => void 0));
  }

  private refresh(): void {
    const room = this.room;
    if (!room) {
      return;
    }
    const client = this.matrix.instance;
    const liveTimeline = room.getLiveTimeline();
    this._messages.set(
      liveTimeline
        .getEvents()
        // Edit events (m.replace) are aggregated onto their target, so hide them.
        // Threaded replies (`threadRootId` set on a non-root) are projected by
        // ThreadsService instead — the SDK already keeps them out of the live
        // timeline when thread support is on, but guard here too in case any leak.
        .filter((e) => isDisplayableMessage(e) && !isThreadReply(e))
        .map((e) => buildMessageView(client, room, e)),
    );
    this._canLoadOlder.set(
      liveTimeline.getPaginationToken(Direction.Backward) !== null,
    );
    // The room is on-screen, so mark its latest message read. Deduped, so live
    // messages clear the badge but paginating older history does not re-send.
    this.markRead(liveTimeline.getEvents());
  }

  /**
   * Send a read receipt for the active room's latest *confirmed* event, clearing
   * its unread badge. Deduped on the last-acked event id so a live message marks
   * read but a no-op refresh (decryption, pagination) doesn't re-send. Pending
   * local echoes are skipped (the SDK rejects a receipt on an unsent event) and
   * any missing/failed receipt API is swallowed so viewing a room never throws.
   */
  private markRead(events: readonly MatrixEvent[]): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    const latest = [...events].reverse().find((e) => !e.status);
    const id = latest?.getId() ?? null;
    if (!latest || !id || id === this.lastReadEventId) {
      return;
    }
    this.lastReadEventId = id;
    try {
      void this.matrix.instance.sendReadReceipt(latest)?.catch(() => undefined);
    } catch {
      // A missing/unsupported receipt API must never break room viewing.
    }
  }
}

/**
 * True for a threaded reply that should live only in its thread, not the main
 * timeline: it carries a thread root id but is not itself the thread root. (A
 * plain `m.in_reply_to` reply has no `threadRootId`, so it stays in the timeline.)
 */
function isThreadReply(event: MatrixEvent): boolean {
  return event.threadRootId !== undefined && !event.isThreadRoot;
}
