import type { EncryptedFileInfo, MediaKind, MediaPayload } from './media.model';
import { displaySafeMime, mimeEssence } from './display-mime';
import type { UnencryptedMark } from './room-encryption';
import { MSC1767_AUDIO, MSC3245_VOICE } from './voice';
import {
  linkifyMessageText,
  mentionNamesIn,
  sanitizeMatrixHtml,
} from './message-html';

/** How many reactors a reaction pill names before "and N others". */
export const MAX_NAMED_REACTORS = 3;

/** A compact preview of the message a reply points at. */
export interface ReplyPreview {
  id: string;
  senderName: string;
  senderInitial: string;
  senderAvatarMxc: string | null;
  body: string;
  /** How the quoted text is marked, when it arrived unencrypted in an encrypted room. */
  mark: UnencryptedMark | null;
}

/**
 * Cap on a received voice message's waveform bars. Renders one DOM node each, so an
 * attacker-controlled `org.matrix.msc1767.audio.waveform` is bounded on receive; well
 * above any sender's real bar count (send uses 60).
 */
const MAX_WAVEFORM_BARS = 512;

/**
 * Shown in place of a body we hold no key for. Exported so every surface that renders an
 * undecryptable message says the same thing, never the SDK's internal
 * `** Unable to decrypt: <reason> **` diagnostic.
 */
export const UNDECRYPTABLE_BODY = '⚠️ Unable to decrypt this message';

/** Whether an event's `m.mentions` names the viewer — the only trustworthy "this is for
 * you" signal, since everything else in the content is written by the sender. */
function mentionsViewer(
  content: Record<string, unknown>,
  selfUserId: string,
): boolean {
  if (selfUserId === '') {
    return false;
  }
  const mentions = content['m.mentions'];
  if (typeof mentions !== 'object' || mentions === null) {
    return false;
  }
  const ids = (mentions as { user_ids?: unknown }).user_ids;
  return Array.isArray(ids) && ids.includes(selfUserId);
}

/** The text of a message body, rendered every way the msgtype branches need it. */
export interface RenderedText {
  /** Plain text, with any reply fallback stripped. */
  text: string;
  /** Sanitized `formatted_body`, or null when the sender didn't format it. */
  html: string | null;
  /** What a text body renders as: `html`, else the plain text with URLs linkified. */
  textHtml: string | null;
}

/**
 * Render a message content block's text into its three forms. `html` and `textHtml` are not
 * interchangeable: a text/emote/notice body renders `textHtml` (bare URLs clickable), while an
 * MSC2530 media caption renders `html`, deliberately un-linkified because a caption is a label.
 * Shared with the edit-history projection so a past revision renders as the live message does.
 */
export function renderTextBody(
  content: Record<string, unknown>,
  isReply: boolean,
  /** The viewer, so a mention OF them can be marked. Omitted where it is unknown. */
  selfUserId = '',
  /** A member's display name, for mention pills; see {@link mentionNamesIn}. */
  nameOf: (userId: string) => string | null | undefined = () => null,
): RenderedText {
  const rawHtml =
    content['format'] === 'org.matrix.custom.html' &&
    typeof content['formatted_body'] === 'string'
      ? (content['formatted_body'] as string)
      : null;
  // From `m.mentions`, never from the body: the sender writes the body, so a link in it
  // proves only that they typed your id, not that they addressed you.
  return renderNormalizedTextBody(
    typeof content['body'] === 'string' ? content['body'] : '',
    rawHtml,
    isReply,
    mentionsViewer(content, selfUserId),
    mentionNamesIn(rawHtml, nameOf),
  );
}

/** Render text after a Matrix adapter has normalized its content fields. */
export function renderNormalizedTextBody(
  body: string,
  formattedBody: string | null,
  isReply: boolean,
  addressesViewer: boolean,
  mentionNames: Readonly<Record<string, string>> = {},
): RenderedText {
  const text = isReply ? stripReplyFallbackText(body) : body;
  const strippedHtml =
    isReply && formattedBody
      ? stripReplyFallbackHtml(formattedBody)
      : formattedBody;
  const html =
    strippedHtml === null
      ? null
      : sanitizeMatrixHtml(strippedHtml, addressesViewer, mentionNames);

  // Plain text (no formatted_body) still gets bare URLs linkified so they're clickable.
  return { text, html, textHtml: html ?? linkifyMessageText(text) };
}

/** A well-formed essence for an inline kind: a bare `image`, `video` or `audio` type. */
const INLINE_ESSENCE = /^(?:image|video|audio)\/[a-z0-9][a-z0-9.+-]*$/;

/** Document types (compared by essence) that are only offered as downloads, never shown inline. */
const DOWNLOAD_ONLY_MIME: ReadonlySet<string> = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'application/xml',
  'text/xml',
]);

/**
 * Project an `m.image`/`m.file`/`m.video`/`m.audio` content block into a
 * {@link MediaPayload}, or null when it lacks a source (`url`/`file`). The kind is
 * derived from the msgtype, then downgraded to `'file'` (download-only) for a declared
 * MIME type that mismatches it, is a download-only document type, or is not a well-formed
 * essence, so only recognisable media is shown inline.
 */
export function normalizeMediaPayload(
  content: Record<string, unknown>,
  msgtype: string,
): MediaPayload | null {
  const file = asEncryptedFile(content['file']);
  // An encrypted source wins over a plaintext one: the bytes are decrypted from `file`, so a
  // `url` beside it must never name or key them.
  const mxc =
    !file && typeof content['url'] === 'string'
      ? (content['url'] as string)
      : null;
  if (!mxc && !file) {
    return null;
  }
  const info = (content['info'] ?? {}) as Record<string, unknown>;
  const declaredMime =
    typeof info['mimetype'] === 'string' ? (info['mimetype'] as string) : null;
  const mimeType = declaredMime ?? 'application/octet-stream';
  const essence = mimeEssence(declaredMime);

  let kind: MediaKind =
    msgtype === 'm.image'
      ? 'image'
      : msgtype === 'm.video'
        ? 'video'
        : msgtype === 'm.audio'
          ? 'audio'
          : 'file';
  // A declared MIME must be a well-formed type of its category and not a download-only
  // document type. `info` is optional, so an undeclared one trusts the msgtype; the blob
  // stays opaque and the media element sniffs the bytes.
  const category = kind === 'file' ? null : kind;
  if (
    declaredMime !== null &&
    (DOWNLOAD_ONLY_MIME.has(essence) ||
      (category &&
        !(INLINE_ESSENCE.test(essence) && essence.startsWith(`${category}/`))))
  ) {
    kind = 'file';
  }

  const filename =
    (typeof content['filename'] === 'string' && content['filename']) ||
    (typeof content['body'] === 'string' && content['body']) ||
    'attachment';

  const thumbInfo = (info['thumbnail_info'] ?? {}) as Record<string, unknown>;
  const thumbnailFile = asEncryptedFile(info['thumbnail_file']);
  // MSC3245: an audio message marked as a voice message, with an MSC1767 waveform.
  const isVoice = kind === 'audio' && content[MSC3245_VOICE] !== undefined;
  const audioExt = (
    content[MSC1767_AUDIO] && typeof content[MSC1767_AUDIO] === 'object'
      ? content[MSC1767_AUDIO]
      : {}
  ) as Record<string, unknown>;
  // Cap the received waveform: it's attacker-controlled and rendered one DOM node
  // per entry, so an unbounded array is a memory/CPU-exhaustion vector.
  const waveform = Array.isArray(audioExt['waveform'])
    ? (audioExt['waveform'] as unknown[])
        .slice(0, MAX_WAVEFORM_BARS)
        .filter((n): n is number => typeof n === 'number')
    : [];
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
        : typeof audioExt['duration'] === 'number'
          ? (audioExt['duration'] as number)
          : undefined,
    thumbnailMxc:
      !thumbnailFile && typeof info['thumbnail_url'] === 'string'
        ? (info['thumbnail_url'] as string)
        : null,
    thumbnailFile,
    thumbnailMimeType:
      typeof thumbInfo['mimetype'] === 'string'
        ? displaySafeMime(thumbInfo['mimetype'])
        : undefined,
    ...(isVoice ? { isVoice: true, waveform } : {}),
  };
}

/** Narrow an untyped `content.file`/`thumbnail_file` to {@link EncryptedFileInfo}. */
export function asEncryptedFile(value: unknown): EncryptedFileInfo | null {
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
export function stripReplyFallbackHtml(html: string): string {
  return html.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/i, '');
}

/** First visible character (sans leading sigil), uppercased, for fallback avatars. */
export function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}
