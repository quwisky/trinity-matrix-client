import {
  EventStatus,
  EventType,
  MsgType,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import type { EncryptedFileInfo, MediaKind, MediaPayload } from './media.model';
import { displaySafeMime, mimeEssence } from './display-mime';
import { isPollStart } from './poll';
import {
  UNENCRYPTED_PREVIEW,
  arrivedInClear,
  shieldSubject,
} from './room-encryption';
import { MSC1767_AUDIO, MSC3245_VOICE } from './voice';
import { linkifyMessageText, sanitizeMatrixHtml } from './message-html';
import { displayContent } from './replacement';

/** An aggregated reaction (`m.annotation`) on a message. */
export interface ReactionView {
  /** The reaction key (usually an emoji). */
  key: string;
  /** How many users reacted with this key. */
  count: number;
  /** Whether the current user is among them (their reaction can be toggled off). */
  reacted: boolean;
  /**
   * The first few reactors by display name for the pill's hint, `'You'` first when
   * {@link reacted}. Capped at {@link MAX_NAMED_REACTORS} because the list is fingerprinted per
   * event on every projection; the full list is read on demand by {@link reactionDetailsFor}.
   */
  reactors: string[];
}

/** One person who reacted, for the "who reacted" list. Mirrors {@link ReceiptView}. */
export interface ReactionReactor {
  userId: string;
  name: string;
  initial: string;
  avatarMxc: string | null;
}

/** Every reactor for one reaction key, for the "who reacted" dialog. */
export interface ReactionDetail {
  key: string;
  /** Whether the current user is among them. */
  reacted: boolean;
  reactors: ReactionReactor[];
}

/** How many reactors a reaction pill names before "and N others". */
export const MAX_NAMED_REACTORS = 3;

/** A compact preview of the message a reply points at. */
export interface ReplyPreview {
  id: string;
  senderName: string;
  senderInitial: string;
  senderAvatarMxc: string | null;
  body: string;
}

/** A member who has read up to a message, for the "seen by" receipt avatars. */
export interface ReceiptView {
  userId: string;
  name: string;
  initial: string;
  avatarMxc: string | null;
}

/** How many receipt avatars to show on a message before it gets noisy. */
const MAX_RECEIPTS = 5;

/**
 * Cap on a received voice message's waveform bars. Renders one DOM node each, so an
 * attacker-controlled `org.matrix.msc1767.audio.waveform` is bounded on receive; well
 * above any sender's real bar count (send uses 60).
 */
const MAX_WAVEFORM_BARS = 512;

/**
 * User ids whose read receipt sits on this event, capped. Excludes the local user and
 * the event's author, whose receipt on their own message carries no information.
 */
function readReceiptUserIds(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): string[] {
  const selfId = client.getUserId();
  const senderId = event.getSender();
  return (room.getUsersReadUpTo?.(event) ?? [])
    .filter((id) => id !== selfId && id !== senderId)
    .slice(0, MAX_RECEIPTS);
}

/** The "seen by" receipts for this event: members whose read marker sits on it. */
export function readReceiptsFor(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): ReceiptView[] {
  return readReceiptUserIds(client, room, event).map((userId) => {
    const member = room.getMember(userId);
    const name = member?.name || userId;
    return {
      userId,
      name,
      initial: initialOf(name),
      avatarMxc: member?.getMxcAvatarUrl() ?? null,
    };
  });
}

/**
 * True when an event should render as a message row (message, sticker, or poll). A state
 * event never is, whatever its type: it is room state, not a turn in the conversation.
 */
export function isDisplayableMessage(event: MatrixEvent): boolean {
  if (event.isState()) {
    return false;
  }
  if (isPollStart(event)) {
    return true;
  }
  return (
    (event.getType() === EventType.RoomMessage ||
      event.getType() === EventType.Sticker) &&
    !event.isRelation(RelationType.Replace)
  );
}

/**
 * Build a short preview of a replied-to message, or null if it isn't loaded. In an encrypted
 * room, a quoted message whose text arrived unencrypted shows as {@link UNENCRYPTED_PREVIEW}:
 * the quote sits inside the replying message and would read as vouched for by its shield.
 * `contentOf` picks what of it to show and `subjectOf` the event that text came from, which
 * the warning judges; a timeline passes what the quoted message's own row shows.
 */
export function replyPreview(
  room: Room,
  eventId: string,
  roomEncrypted: boolean,
  contentOf: (event: MatrixEvent) => Record<string, unknown> = displayContent,
  subjectOf: (event: MatrixEvent) => MatrixEvent = shieldSubject,
): ReplyPreview | null {
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
    : roomEncrypted && arrivedInClear(target, subjectOf(target))
      ? UNENCRYPTED_PREVIEW
      : stripReplyFallbackText((contentOf(target)['body'] as string) ?? '');
  return {
    id: eventId,
    senderName,
    senderInitial: initialOf(senderName),
    senderAvatarMxc: member?.getMxcAvatarUrl() ?? null,
    body: raw.replace(/\s+/g, ' ').trim() || '…',
  };
}

/**
 * Add the user ids whose room membership a rendered message depends on into `into`: the sender,
 * the quoted sender in a reply preview, the reactors a pill names, and the readers behind its
 * "seen by" receipts. A projection re-maps only when one of these members loads or changes, not
 * on every member update in a large room.
 *
 * Each group is bounded (the reply target only while loaded, reactors at `MAX_NAMED_REACTORS`,
 * readers at `MAX_RECEIPTS`), so the set tracks what is on screen, not the room's membership.
 */
export function collectMessageSenders(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  into: Set<string>,
  /**
   * Pass `{ receipts: false }` for a row that renders no "seen by" avatars (a system line, built
   * with `readReceipts: []`): collecting its readers would widen the gate this feeds.
   */
  options: { receipts?: boolean } = {},
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
  // Only the named reactors: nobody beyond the cap renders, so nobody beyond it needs re-mapping.
  for (const [, reactions] of reactionEventsFor(room, event)) {
    for (const reaction of reactions.slice(0, MAX_NAMED_REACTORS)) {
      const reactor = reaction.getSender();
      if (reactor) {
        into.add(reactor);
      }
    }
  }
  // Readers render as avatars like the sender. One who never posted in the loaded window is
  // reachable only here, so without this their member event is discarded at the gate.
  if (options.receipts !== false) {
    for (const reader of readReceiptUserIds(client, room, event)) {
      into.add(reader);
    }
  }
}

/**
 * An event's live reactions grouped by key in the SDK's order (count, then first seen), with
 * redacted ones and empty keys dropped. Shared by the pills and the "who reacted" list.
 */
function reactionEventsFor(
  room: Room,
  event: MatrixEvent,
): [string, MatrixEvent[]][] {
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
  const groups: [string, MatrixEvent[]][] = [];
  for (const [key, set] of annotations) {
    const events = [...set].filter((e) => !e.isRedacted());
    if (events.length > 0) {
      groups.push([key, events]);
    }
  }
  return groups;
}

/** A member's resolved display name, falling back to the raw mxid. */
function displayNameOf(room: Room, userId: string): string {
  // `||` (not `??`) so an empty display name still falls back to the mxid.
  return room.getMember(userId)?.name || userId;
}

/** Read aggregated reactions for an event from the room's relations. */
export function reactionsFor(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): ReactionView[] {
  const myId = client.getUserId();
  return reactionEventsFor(room, event).map(([key, reactions]) => ({
    key,
    count: reactions.length,
    reacted: reactions.some((e) => e.getSender() === myId),
    reactors: namedReactors(room, reactions, myId),
  }));
}

/** The first few reactors by display name, the local user first as "You". */
function namedReactors(
  room: Room,
  reactions: MatrixEvent[],
  myId: string | null,
): string[] {
  const names: string[] = [];
  if (reactions.some((e) => e.getSender() === myId)) {
    names.push('You');
  }
  for (const reaction of reactions) {
    if (names.length >= MAX_NAMED_REACTORS) {
      break;
    }
    const reactor = reaction.getSender();
    if (reactor && reactor !== myId) {
      names.push(displayNameOf(room, reactor));
    }
  }
  return names;
}

/**
 * Every reactor of every reaction on an event, grouped by key: the full list behind a pill's
 * capped {@link ReactionView.reactors}. Read on demand (when the "who reacted" dialog opens),
 * not carried on every {@link MessageView}.
 */
export function reactionDetailsFor(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): ReactionDetail[] {
  const myId = client.getUserId();
  return reactionEventsFor(room, event).map(([key, reactions]) => ({
    key,
    reacted: reactions.some((e) => e.getSender() === myId),
    reactors: reactions.flatMap((reaction) => {
      const userId = reaction.getSender();
      if (!userId) {
        return [];
      }
      const name = displayNameOf(room, userId);
      return [
        {
          userId,
          name,
          initial: initialOf(name),
          avatarMxc: room.getMember(userId)?.getMxcAvatarUrl() ?? null,
        },
      ];
    }),
  }));
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
  );
}

/** Render text after a Matrix adapter has normalized its content fields. */
export function renderNormalizedTextBody(
  body: string,
  formattedBody: string | null,
  isReply: boolean,
  addressesViewer: boolean,
): RenderedText {
  const text = isReply ? stripReplyFallbackText(body) : body;
  const strippedHtml =
    isReply && formattedBody
      ? stripReplyFallbackHtml(formattedBody)
      : formattedBody;
  const html =
    strippedHtml === null
      ? null
      : sanitizeMatrixHtml(strippedHtml, addressesViewer);

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
    msgtype === MsgType.Image
      ? 'image'
      : msgtype === MsgType.Video
        ? 'video'
        : msgtype === MsgType.Audio
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

/** First visible character (sans leading sigil), uppercased, for fallback avatars. */
export function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}
