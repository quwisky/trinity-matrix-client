import { Injectable, SecurityContext, inject, signal } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import {
  Direction,
  EventStatus,
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
import DOMPurify from 'dompurify';
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
import type { EncryptedFileInfo, MediaKind, MediaPayload } from './media.model';

export type MessageKind =
  | 'text'
  | 'emote'
  | 'notice'
  | 'redacted'
  | 'unsupported'
  | MediaKind;

/** An aggregated reaction (`m.annotation`) on a message. */
export interface ReactionView {
  /** The reaction key (usually an emoji). */
  key: string;
  /** How many users reacted with this key. */
  count: number;
  /** Whether the current user is among them (their reaction can be toggled off). */
  reacted: boolean;
}

/** A compact preview of the message a reply points at. */
export interface ReplyPreview {
  id: string;
  senderName: string;
  senderInitial: string;
  senderAvatarUrl: string | null;
  body: string;
}

/** A single rendered timeline message (plain view model — no SDK types leak out). */
export interface MessageView {
  id: string;
  senderId: string;
  senderName: string;
  senderInitial: string;
  senderAvatarUrl: string | null;
  /** Plain-text fallback. */
  body: string;
  /** Sanitized-on-render HTML from `formatted_body` (markdown), or null for plain. */
  html: string | null;
  timestamp: number;
  isOwn: boolean;
  decryptionFailed: boolean;
  /** True once the message has been edited (m.replace). */
  edited: boolean;
  /** Aggregated reactions, ordered by the SDK (count then first-seen). */
  reactions: ReactionView[];
  /** The message this one replies to (`m.in_reply_to`), if loaded. */
  replyTo: ReplyPreview | null;
  /** Local-echo send state: 'sending' / 'failed', or null once confirmed. */
  status: 'sending' | 'failed' | null;
  kind: MessageKind;
  /** Media attachment for image/file/video/audio messages, else null. */
  media: MediaPayload | null;
}

const AVATAR_PX = 64;
const SCROLLBACK = 30;

/**
 * Projects the *active* room's live timeline into a `messages` signal of view
 * models. Re-maps on new events and on async E2EE decryption. The shell opens one
 * room at a time; `matrix-js-sdk` remains the source of truth.
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
        .filter(
          (e) =>
            e.getType() === EventType.RoomMessage &&
            !e.isRelation(RelationType.Replace),
        )
        .map((e) => this.toMessage(client, room, e)),
    );
    this._canLoadOlder.set(
      liveTimeline.getPaginationToken(Direction.Backward) !== null,
    );
  }

  private toMessage(
    client: MatrixClient,
    room: Room,
    event: MatrixEvent,
  ): MessageView {
    const senderId = event.getSender() ?? '';
    const member = room.getMember(senderId);
    const senderName = member?.name ?? senderId;
    const decryptionFailed = event.isDecryptionFailure();
    const { body, html, kind, media } = renderBody(event, decryptionFailed);
    return {
      id: event.getId() ?? '',
      senderId,
      senderName,
      senderInitial: initialOf(senderName),
      senderAvatarUrl:
        member?.getAvatarUrl(
          client.baseUrl,
          AVATAR_PX,
          AVATAR_PX,
          'crop',
          false,
          false,
        ) ?? null,
      body,
      html,
      timestamp: event.getTs(),
      isOwn: senderId === client.getUserId(),
      decryptionFailed,
      edited: event.replacingEvent() !== null,
      reactions: this.reactionsFor(client, room, event),
      replyTo: event.replyEventId
        ? this.replyPreview(client, room, event.replyEventId)
        : null,
      status: mapStatus(event.status),
      kind,
      media,
    };
  }

  /** Build a short preview of a replied-to message, or null if it isn't loaded. */
  private replyPreview(
    client: MatrixClient,
    room: Room,
    eventId: string,
  ): ReplyPreview | null {
    const target = room.findEventById(eventId);
    if (!target) {
      return null;
    }
    const sender = target.getSender() ?? '';
    const member = room.getMember(sender);
    const senderName = member?.name ?? sender;
    const raw = target.isRedacted()
      ? '(message deleted)'
      : stripReplyFallbackText((target.getContent()['body'] as string) ?? '');
    return {
      id: eventId,
      senderName,
      senderInitial: initialOf(senderName),
      senderAvatarUrl:
        member?.getAvatarUrl(
          client.baseUrl,
          AVATAR_PX,
          AVATAR_PX,
          'crop',
          false,
          false,
        ) ?? null,
      body: raw.replace(/\s+/g, ' ').trim() || '…',
    };
  }

  /** Read aggregated reactions for an event from the room's relations. */
  private reactionsFor(
    client: MatrixClient,
    room: Room,
    event: MatrixEvent,
  ): ReactionView[] {
    const id = event.getId();
    if (!id) {
      return [];
    }
    const annotations = room.relations
      .getChildEventsForEvent(id, RelationType.Annotation, EventType.Reaction)
      ?.getSortedAnnotationsByKey();
    if (!annotations) {
      return [];
    }
    const myId = client.getUserId();
    const views: ReactionView[] = [];
    for (const [key, set] of annotations) {
      const events = [...set].filter((e) => !e.isRedacted());
      if (events.length === 0) {
        continue;
      }
      views.push({
        key,
        count: events.length,
        reacted: events.some((e) => e.getSender() === myId),
      });
    }
    return views;
  }

  private renderMarkdown(text: string): { formatted: boolean; html: string } {
    const rendered = marked.parse(text, { async: false }) as string;
    const html = this.sanitizer.sanitize(SecurityContext.HTML, rendered) ?? '';
    return { formatted: htmlToText(html).trim() !== text, html };
  }
}

function mapStatus(status: EventStatus | null): 'sending' | 'failed' | null {
  if (status === EventStatus.SENDING || status === EventStatus.QUEUED) {
    return 'sending';
  }
  if (status === EventStatus.NOT_SENT) {
    return 'failed';
  }
  return null;
}

/** Plain-text content of an HTML string (to detect whether markdown added formatting). */
function htmlToText(html: string): string {
  return (
    new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
  );
}

// Tags/attributes permitted in Matrix `org.matrix.custom.html` message bodies
// (the spec allowlist). Anything outside this set is stripped.
const MATRIX_ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'del',
  'div',
  'em',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'details',
  'summary',
];
// `target` is intentionally omitted: dropping it avoids reverse-tabnabbing
// without needing a post-sanitize rel hook. (Opening message links in a new tab
// safely is a separate follow-up via a click handler.)
const MATRIX_ALLOWED_ATTR = [
  'href',
  'name',
  'alt',
  'title',
  'width',
  'height',
  'src',
  'start',
  'color',
  'class',
  'data-mx-bg-color',
  'data-mx-color',
  'data-mx-spoiler',
];

/**
 * Sanitize sender-provided HTML (`formatted_body`) against the Matrix allowlist.
 * Federated, end-to-end-encrypted content is untrusted and can't be scanned
 * server-side, so it is scrubbed here *explicitly* rather than relying on
 * Angular's implicit `[innerHTML]` sanitization at the render leaf. Never wrap
 * the result in `bypassSecurityTrust*`.
 */
function sanitizeMatrixHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: MATRIX_ALLOWED_TAGS,
    ALLOWED_ATTR: MATRIX_ALLOWED_ATTR,
    // Only safe URL schemes on href/src (DOMPurify also blocks javascript:).
    ALLOWED_URI_REGEXP: /^(?:https?|ftp|mailto|magnet|mxc):/i,
  });
}

interface RenderedBody {
  body: string;
  html: string | null;
  kind: MessageKind;
  media: MediaPayload | null;
}

function renderBody(
  event: MatrixEvent,
  decryptionFailed: boolean,
): RenderedBody {
  if (decryptionFailed) {
    return {
      body: '⚠️ Unable to decrypt this message',
      html: null,
      kind: 'unsupported',
      media: null,
    };
  }
  if (event.isRedacted()) {
    return {
      body: '(message deleted)',
      html: null,
      kind: 'redacted',
      media: null,
    };
  }
  const content = event.getContent();
  const isReply = !!event.replyEventId;
  const raw = (content['body'] as string) ?? '';
  const text = isReply ? stripReplyFallbackText(raw) : raw;
  // Markdown is delivered as HTML in `formatted_body` (format = custom HTML).
  const rawHtml =
    content['format'] === 'org.matrix.custom.html' &&
    typeof content['formatted_body'] === 'string'
      ? (content['formatted_body'] as string)
      : null;
  const strippedHtml =
    isReply && rawHtml ? stripReplyFallbackHtml(rawHtml) : rawHtml;
  const html = strippedHtml === null ? null : sanitizeMatrixHtml(strippedHtml);

  switch (content.msgtype) {
    case MsgType.Text:
      return { body: text, html, kind: 'text', media: null };
    case MsgType.Emote:
      return { body: text, html, kind: 'emote', media: null };
    case MsgType.Notice:
      return { body: text, html, kind: 'notice', media: null };
    case MsgType.Image:
    case MsgType.File:
    case MsgType.Audio:
    case MsgType.Video: {
      const media = buildMediaPayload(content, content.msgtype);
      // A malformed media event (no url/file) falls back to a plain label.
      if (!media) {
        return {
          body: text || `[${String(content.msgtype).replace(/^m\./, '')}]`,
          html: null,
          kind: 'unsupported',
          media: null,
        };
      }
      return { body: media.filename, html: null, kind: media.kind, media };
    }
    default:
      return {
        body: text || '[unsupported message]',
        html: null,
        kind: 'unsupported',
        media: null,
      };
  }
}

/** MIME types we never render inline (script-bearing), forced to download-only. */
const UNSAFE_INLINE_MIME = /^(?:image\/svg\+xml|text\/html)$/i;

/**
 * Project an `m.image`/`m.file`/`m.video`/`m.audio` content block into a
 * {@link MediaPayload}, or null when it lacks a source (`url`/`file`). The kind is
 * derived from the msgtype, then downgraded to `'file'` (download-only) for unknown
 * or script-bearing MIME types so nothing scriptable is rendered inline.
 */
function buildMediaPayload(
  content: Record<string, unknown>,
  msgtype: string,
): MediaPayload | null {
  const mxc =
    typeof content['url'] === 'string' ? (content['url'] as string) : null;
  const file = asEncryptedFile(content['file']);
  if (!mxc && !file) {
    return null;
  }
  const info = (content['info'] ?? {}) as Record<string, unknown>;
  const mimeType =
    typeof info['mimetype'] === 'string'
      ? (info['mimetype'] as string)
      : 'application/octet-stream';

  let kind: MediaKind =
    msgtype === MsgType.Image
      ? 'image'
      : msgtype === MsgType.Video
        ? 'video'
        : msgtype === MsgType.Audio
          ? 'audio'
          : 'file';
  // Inline rendering requires a MIME that matches its category and isn't scriptable.
  const category = kind === 'file' ? null : kind;
  if (
    UNSAFE_INLINE_MIME.test(mimeType) ||
    (category && !mimeType.toLowerCase().startsWith(`${category}/`))
  ) {
    kind = 'file';
  }

  const filename =
    (typeof content['filename'] === 'string' && content['filename']) ||
    (typeof content['body'] === 'string' && content['body']) ||
    'attachment';

  const thumbInfo = (info['thumbnail_info'] ?? {}) as Record<string, unknown>;
  return {
    kind,
    mxc,
    file,
    filename: filename as string,
    mimeType,
    size:
      typeof info['size'] === 'number' ? (info['size'] as number) : undefined,
    width: typeof info['w'] === 'number' ? (info['w'] as number) : undefined,
    height: typeof info['h'] === 'number' ? (info['h'] as number) : undefined,
    durationMs:
      typeof info['duration'] === 'number'
        ? (info['duration'] as number)
        : undefined,
    thumbnailMxc:
      typeof info['thumbnail_url'] === 'string'
        ? (info['thumbnail_url'] as string)
        : null,
    thumbnailFile: asEncryptedFile(info['thumbnail_file']),
    thumbnailMimeType:
      typeof thumbInfo['mimetype'] === 'string'
        ? (thumbInfo['mimetype'] as string)
        : undefined,
  };
}

/** Narrow an untyped `content.file`/`thumbnail_file` to {@link EncryptedFileInfo}. */
function asEncryptedFile(value: unknown): EncryptedFileInfo | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const f = value as Record<string, unknown>;
  if (typeof f['url'] === 'string' && typeof f['iv'] === 'string' && f['key']) {
    return f as unknown as EncryptedFileInfo;
  }
  return null;
}

/**
 * Strip the rich-reply fallback from a body: the leading `> …` quote lines and
 * the blank line that separates them from the actual reply text.
 */
function stripReplyFallbackText(body: string): string {
  if (!body.startsWith('>')) {
    return body;
  }
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) {
    i++;
  }
  if (i < lines.length && lines[i].trim() === '') {
    i++;
  }
  return lines.slice(i).join('\n');
}

/** Strip the `<mx-reply>…</mx-reply>` fallback block from formatted (HTML) replies. */
function stripReplyFallbackHtml(html: string): string {
  return html.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/i, '');
}

/** Escape text for safe interpolation into the `<mx-reply>` HTML fallback. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** First visible character (sans leading sigil), uppercased, for fallback avatars. */
function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}
