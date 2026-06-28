import { Injectable, SecurityContext, inject, signal } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import {
  Direction,
  EventType,
  MatrixEventEvent,
  MsgType,
  RelationType,
  RoomEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { marked } from 'marked';
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
  escapeHtml,
  isDisplayableMessage,
  stripReplyFallbackText,
  type MessageView,
} from './message-view';

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
    this.refresh();

    // Best-effort read receipt for the most recent *confirmed* event. Pending
    // local echoes are skipped (the SDK rejects a receipt on an unsent event),
    // and the call is fire-and-forget but its rejection is swallowed.
    const events = room.getLiveTimeline().getEvents();
    const last = [...events].reverse().find((e) => !e.status);
    if (last) {
      client.sendReadReceipt(last).catch(() => undefined);
    }
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
      const { formatted, html } = this.renderMarkdown(text);
      return from(
        formatted
          ? client.sendHtmlMessage(room.roomId, text, html)
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
      const { formatted, html } = this.renderMarkdown(text);
      const newContent = formatted
        ? {
            msgtype: MsgType.Text,
            body: text,
            format: 'org.matrix.custom.html',
            formatted_body: html,
          }
        : { msgtype: MsgType.Text, body: text };
      const content = {
        msgtype: MsgType.Text,
        body: `* ${text}`,
        ...(formatted
          ? { format: 'org.matrix.custom.html', formatted_body: `* ${html}` }
          : {}),
        'm.new_content': newContent,
        'm.relates_to': {
          rel_type: RelationType.Replace,
          event_id: messageId,
        },
      };
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
      const target = room.findEventById(messageId);
      const sender = target?.getSender() ?? '';
      const origBody = stripReplyFallbackText(
        (target?.getContent()['body'] as string) ?? '',
      );
      const firstLine = origBody.split('\n')[0] ?? '';
      const { formatted, html } = this.renderMarkdown(text);
      const replyHtml = formatted ? html : escapeHtml(text);
      // Full rich-reply fallback so every client renders it correctly: a plain
      // `> …` quote in `body` and an `<mx-reply>` block in `formatted_body`.
      const roomLink = `https://matrix.to/#/${room.roomId}/${messageId}`;
      const userLink = `https://matrix.to/#/${sender}`;
      const mxReply =
        `<mx-reply><blockquote>` +
        `<a href="${roomLink}">In reply to</a> ` +
        `<a href="${userLink}">${escapeHtml(sender)}</a><br>` +
        `${escapeHtml(firstLine)}</blockquote></mx-reply>`;
      const content = {
        msgtype: MsgType.Text,
        body: `> <${sender}> ${firstLine}\n\n${text}`,
        format: 'org.matrix.custom.html',
        formatted_body: `${mxReply}${replyHtml}`,
        'm.relates_to': { 'm.in_reply_to': { event_id: messageId } },
      };
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
      const mine = this.myReactionId(client, room, messageId, key);
      if (mine) {
        return from(client.redactEvent(room.roomId, mine));
      }
      const content = {
        'm.relates_to': {
          rel_type: RelationType.Annotation,
          event_id: messageId,
          key,
        },
      };
      return from(
        client.sendEvent(room.roomId, EventType.Reaction, content as never),
      );
    }).pipe(map(() => void 0));
  }

  /** The id of the current user's own reaction event for a key, if any. */
  private myReactionId(
    client: MatrixClient,
    room: Room,
    messageId: string,
    key: string,
  ): string | null {
    const annotations = room.relations
      .getChildEventsForEvent(
        messageId,
        RelationType.Annotation,
        EventType.Reaction,
      )
      ?.getSortedAnnotationsByKey();
    const match = annotations?.find(([k]) => k === key);
    if (!match) {
      return null;
    }
    const myId = client.getUserId();
    const mine = [...match[1]].find(
      (e) => !e.isRedacted() && e.getSender() === myId,
    );
    return mine?.getId() ?? null;
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
  }

  private renderMarkdown(text: string): { formatted: boolean; html: string } {
    const rendered = marked.parse(text, { async: false }) as string;
    const html = this.sanitizer.sanitize(SecurityContext.HTML, rendered) ?? '';
    return { formatted: htmlToText(html).trim() !== text, html };
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

/** Plain-text content of an HTML string (to detect whether markdown added formatting). */
function htmlToText(html: string): string {
  return (
    new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
  );
}
