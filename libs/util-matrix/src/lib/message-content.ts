import { SecurityContext } from '@angular/core';
import type { DomSanitizer } from '@angular/platform-browser';
import {
  EventType,
  MsgType,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { marked } from 'marked';
import { escapeHtml, stripReplyFallbackText } from './message-view';

/**
 * Send-side content builders shared by the main timeline ({@link TimelineService})
 * and the in-thread composer ({@link ThreadsService}) so both render markdown and
 * build edit/reply/reaction payloads identically — the outbound counterpart to
 * `message-view.ts` (which projects events *into* render models). No SDK types leak
 * to components; only core services call these.
 *
 * The `m.thread` relation itself is NOT built here: the SDK adds it (with the right
 * `is_falling_back` and `m.in_reply_to`) when a `threadId` is passed to the send
 * call, so a thread send reuses the exact same content shape as the main timeline.
 */

/** Result of rendering composer markdown to sanitized HTML. */
export interface RenderedMarkdown {
  /** True when the markdown actually added formatting (else send/store as plain text). */
  formatted: boolean;
  /** Sanitized HTML for `formatted_body`. */
  html: string;
}

/** A user mentioned in a composed message (drives `m.mentions` + a matrix.to pill). */
export interface Mention {
  userId: string;
  /** The exact text inserted for the mention (e.g. "@Alice"), matched to place the pill. */
  display: string;
}

/** An `m.mentions` block for the given user ids, or `{}` when there are none. */
function mentionsBlock(userIds: string[]): Record<string, unknown> {
  const ids = [...new Set(userIds)].filter(Boolean);
  return ids.length > 0 ? { 'm.mentions': { user_ids: ids } } : {};
}

/**
 * Turn each mention's plain `@display` in the already-sanitized HTML into a
 * matrix.to pill link — once per mention (first not-yet-replaced occurrence). The
 * display is matched in its HTML-escaped form since it appears as text in the markup;
 * user ids can't contain `"`, so the href needs no further escaping.
 */
function applyMentionPills(html: string, mentions: Mention[]): string {
  let out = html;
  for (const mention of mentions) {
    const needle = escapeHtml(mention.display);
    const at = out.indexOf(needle);
    if (at === -1) {
      continue;
    }
    const pill = `<a href="https://matrix.to/#/${mention.userId}">${needle}</a>`;
    out = out.slice(0, at) + pill + out.slice(at + needle.length);
  }
  return out;
}

/**
 * Render composer markdown to sanitized HTML. `formatted` is false when the HTML
 * carries no formatting beyond the plain text, so the caller can send plain text.
 */
export function renderMarkdown(
  sanitizer: DomSanitizer,
  text: string,
): RenderedMarkdown {
  const rendered = marked.parse(text, { async: false }) as string;
  const html = sanitizer.sanitize(SecurityContext.HTML, rendered) ?? '';
  return { formatted: htmlToText(html).trim() !== text, html };
}

/**
 * MSC2530 caption fields for a media message. With a caption, `body` carries the
 * caption text (rich when markdown formats it) and `filename` preserves the real
 * file name; without one, `body` is the file name (the pre-caption behaviour).
 */
export function mediaCaptionFields(
  sanitizer: DomSanitizer,
  filename: string,
  caption: string,
): Record<string, string> {
  const text = caption.trim();
  if (!text) {
    return { body: filename };
  }
  const md = renderMarkdown(sanitizer, text);
  return {
    body: text,
    filename,
    ...(md.formatted
      ? { format: 'org.matrix.custom.html', formatted_body: md.html }
      : {}),
  };
}

/**
 * `m.text` content: rich (HTML) when markdown formatted it OR the message mentions
 * someone (mentions need a `formatted_body` for the pill), else plain text. Any
 * mentions add `m.mentions` (so modern homeservers notify) and matrix.to pills.
 */
export function textMessageContent(
  text: string,
  md: RenderedMarkdown,
  mentions: Mention[] = [],
) {
  if (md.formatted || mentions.length > 0) {
    return {
      msgtype: MsgType.Text,
      body: text,
      format: 'org.matrix.custom.html',
      formatted_body: applyMentionPills(md.html, mentions),
      ...mentionsBlock(mentions.map((m) => m.userId)),
    };
  }
  return { msgtype: MsgType.Text, body: text };
}

/** The classic shrug the `/shrug` command appends. */
const SHRUG = '¯\\_(ツ)_/¯';

/** The IRC-style commands the composer recognizes. */
const SLASH_COMMANDS = ['me', 'shrug', 'plain', 'spoiler'] as const;
const SLASH_RE = new RegExp(
  `^/(${SLASH_COMMANDS.join('|')})(?:[ \\t]+([\\s\\S]*))?$`,
  'i',
);

/**
 * Parse a leading IRC-style slash command (`/me`, `/shrug`, `/plain`, `/spoiler`) into its
 * name + trimmed argument, or null when the text isn't one of them (so it sends literally —
 * `/method`, `/etc/passwd`, and unknown commands are all left as plain text).
 */
export function parseSlashCommand(
  text: string,
): { command: string; arg: string } | null {
  const match = SLASH_RE.exec(text);
  return match
    ? { command: match[1].toLowerCase(), arg: (match[2] ?? '').trim() }
    : null;
}

/** `m.emote` content (`/me`), rich when the markdown adds formatting. */
export function emoteMessageContent(text: string, md: RenderedMarkdown) {
  if (md.formatted) {
    return {
      msgtype: MsgType.Emote,
      body: text,
      format: 'org.matrix.custom.html',
      formatted_body: md.html,
    };
  }
  return { msgtype: MsgType.Emote, body: text };
}

/** `m.location` content for a shared point, with the `geo:` URI + MSC3488 fields. */
export function locationMessageContent(
  lat: number,
  lng: number,
  label = 'Shared location',
) {
  const geoUri = `geo:${lat},${lng}`;
  return {
    msgtype: MsgType.Location,
    body: label,
    geo_uri: geoUri,
    'org.matrix.msc3488.location': { uri: geoUri, description: label },
    'org.matrix.msc3488.asset': { type: 'm.self' },
    'org.matrix.msc1767.text': label,
  };
}

/** `m.text` spoiler content (`/spoiler`) — an `<span data-mx-spoiler>` formatted body. */
export function spoilerMessageContent(text: string) {
  return {
    msgtype: MsgType.Text,
    body: text,
    format: 'org.matrix.custom.html',
    formatted_body: `<span data-mx-spoiler>${escapeHtml(text)}</span>`,
  };
}

/**
 * Build the message content for a leading slash command, or null when the text isn't a
 * recognized command (send it as a normal message). `renderHtml` renders the argument's
 * markdown (injected so this stays DI-free). Empty-argument `/me`/`/plain`/`/spoiler` also
 * return null — nothing to send — so the raw text isn't swallowed.
 */
export function slashCommandContent(
  text: string,
  renderHtml: (markdown: string) => RenderedMarkdown,
): Record<string, unknown> | null {
  const parsed = parseSlashCommand(text);
  if (!parsed) {
    return null;
  }
  const { command, arg } = parsed;
  switch (command) {
    case 'me':
      return arg ? emoteMessageContent(arg, renderHtml(arg)) : null;
    case 'shrug':
      return { msgtype: MsgType.Text, body: arg ? `${arg} ${SHRUG}` : SHRUG };
    case 'plain':
      return arg ? { msgtype: MsgType.Text, body: arg } : null;
    case 'spoiler':
      return arg ? spoilerMessageContent(arg) : null;
    default:
      return null;
  }
}

/**
 * `m.replace` edit content targeting `messageId`, with the leading `* ` fallback.
 * Mentions land in `m.new_content` (the effective content) — not the top-level
 * replace event — so an edit that keeps existing mentions doesn't re-notify.
 */
export function editMessageContent(
  messageId: string,
  text: string,
  md: RenderedMarkdown,
  mentions: Mention[] = [],
) {
  const rich = md.formatted || mentions.length > 0;
  return {
    msgtype: MsgType.Text,
    body: `* ${text}`,
    ...(rich
      ? {
          format: 'org.matrix.custom.html',
          formatted_body: `* ${applyMentionPills(md.html, mentions)}`,
        }
      : {}),
    'm.new_content': textMessageContent(text, md, mentions),
    'm.relates_to': {
      rel_type: RelationType.Replace,
      event_id: messageId,
    },
  };
}

/**
 * Rich-reply content (`m.in_reply_to`): a plain `> …` quote in `body` and an
 * `<mx-reply>` block in `formatted_body`, so every client renders (and strips) it
 * correctly. When sent with a `threadId`, the SDK layers the `m.thread` relation on
 * top with `is_falling_back: false`, keeping this as a real in-thread reply.
 */
export function replyMessageContent(
  room: Room,
  messageId: string,
  text: string,
  md: RenderedMarkdown,
  mentions: Mention[] = [],
) {
  const target = room.findEventById(messageId);
  const sender = target?.getSender() ?? '';
  const origBody = stripReplyFallbackText(
    (target?.getContent()['body'] as string) ?? '',
  );
  const firstLine = origBody.split('\n')[0] ?? '';
  const replyHtml = applyMentionPills(
    md.formatted ? md.html : escapeHtml(text),
    mentions,
  );
  const roomLink = `https://matrix.to/#/${room.roomId}/${messageId}`;
  const userLink = `https://matrix.to/#/${sender}`;
  const mxReply =
    `<mx-reply><blockquote>` +
    `<a href="${roomLink}">In reply to</a> ` +
    `<a href="${userLink}">${escapeHtml(sender)}</a><br>` +
    `${escapeHtml(firstLine)}</blockquote></mx-reply>`;
  return {
    msgtype: MsgType.Text,
    body: `> <${sender}> ${firstLine}\n\n${text}`,
    format: 'org.matrix.custom.html',
    formatted_body: `${mxReply}${replyHtml}`,
    'm.relates_to': { 'm.in_reply_to': { event_id: messageId } },
    // A reply pings the message's author, plus anyone @-mentioned in the reply.
    ...mentionsBlock([sender, ...mentions.map((m) => m.userId)]),
  };
}

/** `m.annotation` reaction content for `messageId`/`key`. */
export function annotationContent(messageId: string, key: string) {
  return {
    'm.relates_to': {
      rel_type: RelationType.Annotation,
      event_id: messageId,
      key,
    },
  };
}

/** The id of the current user's own reaction event for a key on a message, if any. */
export function myReactionId(
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

/**
 * Short, single-line preview of a message event's text — feeds both the main
 * timeline's thread indicator and the room list's muted last-message line.
 * Handles undecryptable and redacted events, strips any rich-reply fallback quote,
 * collapses whitespace, and returns '…' when nothing renders.
 */
export function messagePreview(event: MatrixEvent): string {
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

/** Plain-text content of an HTML string (to detect whether markdown added formatting). */
function htmlToText(html: string): string {
  return (
    new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
  );
}
