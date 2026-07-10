import {
  EventStatus,
  EventType,
  MsgType,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import DOMPurify from 'dompurify';
import type { EncryptedFileInfo, MediaKind, MediaPayload } from './media.model';

/**
 * Shared, framework-free projection of a `matrix-js-sdk` {@link MatrixEvent} into a
 * plain {@link MessageView}. Extracted from `TimelineService` so the main timeline
 * AND the threads view render identical view models with identical decryption
 * ("unable to decrypt") and sanitization handling — no SDK types leak past here.
 */

export type MessageKind =
  'text' | 'emote' | 'notice' | 'redacted' | 'unsupported' | MediaKind;

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
  senderAvatarMxc: string | null;
  body: string;
}

/** A single rendered timeline message (plain view model — no SDK types leak out). */
export interface MessageView {
  id: string;
  senderId: string;
  senderName: string;
  senderInitial: string;
  senderAvatarMxc: string | null;
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
  /** MSC2530 caption text on a media message (else null). */
  caption: string | null;
  /** Sanitized HTML for a rich media caption (else null). */
  captionHtml: string | null;
}

/**
 * Project a single timeline (or thread) event into a {@link MessageView}, resolving
 * the sender from room state, decryption state, reactions, and reply preview.
 */
export function buildMessageView(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): MessageView {
  const senderId = event.getSender() ?? '';
  const member = room.getMember(senderId);
  // `||` (not `??`) so an empty display name still falls back to the mxid.
  const senderName = member?.name || senderId;
  const decryptionFailed = event.isDecryptionFailure();
  const {
    body,
    html,
    kind,
    media,
    caption = null,
    captionHtml = null,
  } = renderBody(event, decryptionFailed);
  return {
    id: event.getId() ?? '',
    senderId,
    senderName,
    senderInitial: initialOf(senderName),
    senderAvatarMxc: member?.getMxcAvatarUrl() ?? null,
    body,
    html,
    timestamp: event.getTs(),
    isOwn: senderId === client.getUserId(),
    decryptionFailed,
    edited: event.replacingEvent() !== null,
    reactions: reactionsFor(client, room, event),
    replyTo: event.replyEventId ? replyPreview(room, event.replyEventId) : null,
    status: mapStatus(event.status),
    kind,
    media,
    caption,
    captionHtml,
  };
}

/** True when an event should render as a message row (not an aggregated edit). */
export function isDisplayableMessage(event: MatrixEvent): boolean {
  return (
    event.getType() === EventType.RoomMessage &&
    !event.isRelation(RelationType.Replace)
  );
}

/**
 * Whether the current user may edit this view: own, confirmed (no pending/failed
 * send), decrypted, not redacted, and text (media isn't editable). Shared by the
 * main timeline and the in-thread composer so the rule stays in one place.
 */
export function isEditableMessage(message: MessageView): boolean {
  return (
    message.isOwn &&
    !message.status &&
    !message.decryptionFailed &&
    message.kind !== 'redacted' &&
    !message.media
  );
}

/** Build a short preview of a replied-to message, or null if it isn't loaded. */
export function replyPreview(room: Room, eventId: string): ReplyPreview | null {
  const target = room.findEventById(eventId);
  if (!target) {
    return null;
  }
  const sender = target.getSender() ?? '';
  const member = room.getMember(sender);
  // `||` (not `??`) so an empty display name still falls back to the mxid.
  const senderName = member?.name || sender;
  const raw = target.isRedacted()
    ? '(message deleted)'
    : stripReplyFallbackText((target.getContent()['body'] as string) ?? '');
  return {
    id: eventId,
    senderName,
    senderInitial: initialOf(senderName),
    senderAvatarMxc: member?.getMxcAvatarUrl() ?? null,
    body: raw.replace(/\s+/g, ' ').trim() || '…',
  };
}

/**
 * Add the user ids whose room membership a rendered message depends on — the
 * sender (shown in the header) and, for a reply, the quoted sender shown in the
 * reply preview — into `into`. A projection uses this to re-map only when a member
 * it actually references loads or changes its name/avatar, rather than on every
 * member update in a large room. The reply target's sender is included only when
 * the target is loaded, which is exactly when a (possibly stale) preview renders.
 */
export function collectMessageSenders(
  room: Room,
  event: MatrixEvent,
  into: Set<string>,
): void {
  const sender = event.getSender();
  if (sender) {
    into.add(sender);
  }
  const replyId = event.replyEventId;
  if (replyId) {
    const targetSender = room.findEventById(replyId)?.getSender();
    if (targetSender) {
      into.add(targetSender);
    }
  }
}

/** Read aggregated reactions for an event from the room's relations. */
export function reactionsFor(
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

export function mapStatus(
  status: EventStatus | null,
): 'sending' | 'failed' | null {
  if (status === EventStatus.SENDING || status === EventStatus.QUEUED) {
    return 'sending';
  }
  if (status === EventStatus.NOT_SENT) {
    return 'failed';
  }
  return null;
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

// Image sources we consider local (no network fetch on render). Remote schemes
// are stripped below so sender HTML can't smuggle a tracking pixel.
const LOCAL_IMG_SCHEME = /^(?:mxc|blob|data):/i;

// The only `class` tokens Matrix sanctions: `language-*` (syntax highlighting on
// <code>) and the spoiler class. `class` is otherwise allowed globally, so a
// sender could borrow app/Ionic classes to spoof UI chrome — restrict to these.
const ALLOWED_CLASS = /^(?:language-[\w-]+|mx-spoiler)$/;

// A sender's `formatted_body` can embed `<img src="https://attacker/x.gif">`,
// which the browser would fetch on render — leaking the viewer's IP and acting
// as a read receipt. Inline mxc rendering isn't wired yet, so strip the `src`
// of any non-local image: this blocks remote auto-loading outright while
// leaving mxc/blob/data sources intact for when inline rendering lands. The hook
// also filters the `class` attribute to the Matrix-sanctioned allowlist. Hook is
// registered once at module load; it only affects `sanitizeMatrixHtml` (the
// composer path uses Angular's DomSanitizer, not DOMPurify).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName === 'IMG' && node.hasAttribute('src')) {
    const src = node.getAttribute('src') ?? '';
    if (!LOCAL_IMG_SCHEME.test(src)) {
      node.removeAttribute('src');
    }
  }
  if (node.hasAttribute('class')) {
    const kept = (node.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((token) => ALLOWED_CLASS.test(token));
    if (kept.length > 0) {
      node.setAttribute('class', kept.join(' '));
    } else {
      node.removeAttribute('class');
    }
  }
  // Normalise a spoiler for the renderer. `data-mx-spoiler` marks it in Matrix HTML,
  // but Angular's `[innerHTML]` sanitizer (the defence-in-depth re-scrub at the render
  // leaf) drops all `data-*` attributes — so tag it with the sanctioned `mx-spoiler`
  // class instead (class/tabindex/role all survive that pass). Focusable + role=button
  // so keyboard users can reveal it too (pointer users get click-to-reveal).
  if (node.hasAttribute('data-mx-spoiler')) {
    node.classList.add('mx-spoiler');
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
  }
});

// Memoize sanitization by raw input: DOMPurify is a pure function of the html
// string (the config + hook are constant), so the same `formatted_body` always
// yields the same scrubbed output. Caching it means the timeline/thread
// projections can re-derive a view (status flip, edit, decryption) without paying
// for DOMPurify again, and identical bodies across messages are scrubbed once.
// Bounded with FIFO eviction so a long-lived session can't grow it unboundedly.
const SANITIZED_HTML_CACHE_MAX = 1000;
const sanitizedHtmlCache = new Map<string, string>();

/**
 * Sanitize sender-provided HTML (`formatted_body`) against the Matrix allowlist.
 * Federated, end-to-end-encrypted content is untrusted and can't be scanned
 * server-side, so it is scrubbed here *explicitly* rather than relying on
 * Angular's implicit `[innerHTML]` sanitization at the render leaf. Never wrap
 * the result in `bypassSecurityTrust*`. The result is memoized by raw input (see
 * {@link sanitizedHtmlCache}); the scrubbed output is identical regardless.
 */
export function sanitizeMatrixHtml(html: string): string {
  const memoized = sanitizedHtmlCache.get(html);
  if (memoized !== undefined) {
    return memoized;
  }
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: MATRIX_ALLOWED_TAGS,
    ALLOWED_ATTR: MATRIX_ALLOWED_ATTR,
    // Only safe URL schemes on href/src (DOMPurify also blocks javascript:).
    ALLOWED_URI_REGEXP: /^(?:https?|ftp|mailto|magnet|mxc):/i,
  });
  if (sanitizedHtmlCache.size >= SANITIZED_HTML_CACHE_MAX) {
    const oldest = sanitizedHtmlCache.keys().next().value;
    if (oldest !== undefined) {
      sanitizedHtmlCache.delete(oldest);
    }
  }
  sanitizedHtmlCache.set(html, clean);
  return clean;
}

interface RenderedBody {
  body: string;
  html: string | null;
  kind: MessageKind;
  media: MediaPayload | null;
  caption?: string | null;
  captionHtml?: string | null;
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
      // MSC2530: a `filename` distinct from `body` marks `body` as a caption —
      // render it alongside the media (rich when the sender formatted it).
      const captioned =
        typeof content['filename'] === 'string' &&
        !!text &&
        text !== media.filename;
      return {
        body: media.filename,
        html: null,
        kind: media.kind,
        media,
        caption: captioned ? text : null,
        captionHtml: captioned ? html : null,
      };
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
export function stripReplyFallbackText(body: string): string {
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
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** First visible character (sans leading sigil), uppercased, for fallback avatars. */
export function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}
