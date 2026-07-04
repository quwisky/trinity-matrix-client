import { SecurityContext } from '@angular/core';
import type { DomSanitizer } from '@angular/platform-browser';
import {
  EventType,
  MsgType,
  RelationType,
  type MatrixClient,
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

/** `m.text` content: rich (HTML) when markdown formatted it, else plain text. */
export function textMessageContent(text: string, md: RenderedMarkdown) {
  return md.formatted
    ? {
        msgtype: MsgType.Text,
        body: text,
        format: 'org.matrix.custom.html',
        formatted_body: md.html,
      }
    : { msgtype: MsgType.Text, body: text };
}

/** `m.replace` edit content targeting `messageId`, with the leading `* ` fallback. */
export function editMessageContent(
  messageId: string,
  text: string,
  md: RenderedMarkdown,
) {
  return {
    msgtype: MsgType.Text,
    body: `* ${text}`,
    ...(md.formatted
      ? { format: 'org.matrix.custom.html', formatted_body: `* ${md.html}` }
      : {}),
    'm.new_content': textMessageContent(text, md),
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
) {
  const target = room.findEventById(messageId);
  const sender = target?.getSender() ?? '';
  const origBody = stripReplyFallbackText(
    (target?.getContent()['body'] as string) ?? '',
  );
  const firstLine = origBody.split('\n')[0] ?? '';
  const replyHtml = md.formatted ? md.html : escapeHtml(text);
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

/** Plain-text content of an HTML string (to detect whether markdown added formatting). */
function htmlToText(html: string): string {
  return (
    new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
  );
}
