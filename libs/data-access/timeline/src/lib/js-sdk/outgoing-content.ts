import {
  EventType,
  MsgType,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import {
  MSC1767_AUDIO,
  MSC3245_VOICE,
  asEncryptedFile,
  escapeHtml,
  locationMessageContent,
  parseGeoUri,
  stripReplyFallbackHtml,
  stripReplyFallbackText,
} from '@trinity/util/matrix';
import { displayContent } from '@trinity/data-access/matrix-client';
import type { OutgoingText } from '../timeline-engine';

/**
 * The `m.mentions` block, always present even when empty: its presence makes a homeserver
 * skip the legacy body-matching push rules (MSC3952).
 */
function mentionsBlock(
  userIds: readonly string[],
  room: boolean,
): Record<string, unknown> {
  const ids = [...new Set(userIds)].filter(Boolean);
  return {
    'm.mentions': {
      ...(ids.length > 0 ? { user_ids: ids } : {}),
      ...(room ? { room: true } : {}),
    },
  };
}

/** `m.text`, `m.emote` or `m.notice` content, rich when the text has a formatted body. */
export function textContent(message: OutgoingText): Record<string, unknown> {
  return {
    msgtype: `m.${message.msgtype}`,
    body: message.body,
    ...(message.formattedBody !== null
      ? {
          format: 'org.matrix.custom.html',
          formatted_body: message.formattedBody,
        }
      : {}),
    ...mentionsBlock(message.mentions.userIds, message.mentions.room),
  };
}

/**
 * `m.replace` edit content targeting `messageId`, with the leading `* ` fallback.
 *
 * `m.mentions` appears both at the top level and in `m.new_content`: the nested copy is
 * effective, the top-level one stops legacy body rules firing on the `* …` fallback.
 */
export function editContent(
  messageId: string,
  message: OutgoingText,
): Record<string, unknown> {
  return {
    msgtype: `m.${message.msgtype}`,
    body: `* ${message.body}`,
    ...mentionsBlock(message.mentions.userIds, message.mentions.room),
    ...(message.formattedBody !== null
      ? {
          format: 'org.matrix.custom.html',
          formatted_body: `* ${message.formattedBody}`,
        }
      : {}),
    'm.new_content': textContent(message),
    'm.relates_to': {
      rel_type: RelationType.Replace,
      event_id: messageId,
    },
  };
}

/**
 * Rich-reply content (`m.in_reply_to`): a plain `> …` quote in `body` and an `<mx-reply>`
 * block in `formatted_body`. With a `threadId` the SDK layers the `m.thread` relation on top
 * with `is_falling_back: false`.
 *
 * `target` defaults to the room's copy of `messageId`; pass one fetched from the server when
 * the room no longer holds it. With no target the reply keeps its relation but carries no
 * quote: the fallback is optional, and an empty `> <>` one is worse. `contentOf` picks what
 * of the target to quote; a timeline passes what the target's own row shows.
 */
export function replyMessageContent(
  room: Room,
  messageId: string,
  message: OutgoingText,
  target: MatrixEvent | undefined = room.findEventById(messageId),
  contentOf: (event: MatrixEvent) => Record<string, unknown> = displayContent,
): Record<string, unknown> {
  const replyHtml =
    message.formattedBody ??
    escapeHtml(message.body).replace(/\r\n?|\n/g, '<br>');
  const sender = target?.getSender() ?? '';
  // A target that failed to decrypt still names its author, who is pinged, but its body is
  // the SDK's "Unable to decrypt" placeholder, which is not worth quoting.
  const quote =
    target && sender && !target.isDecryptionFailure()
      ? replyFallback(room, messageId, sender, target, contentOf)
      : null;
  return {
    msgtype: `m.${message.msgtype}`,
    body: quote ? `${quote.body}${message.body}` : message.body,
    format: 'org.matrix.custom.html',
    formatted_body: `${quote?.html ?? ''}${replyHtml}`,
    'm.relates_to': { 'm.in_reply_to': { event_id: messageId } },
    // A reply pings the author plus anyone @-mentioned in the reply's own words.
    ...mentionsBlock(
      [sender, ...message.mentions.userIds],
      message.mentions.room,
    ),
  };
}

/** The `> <sender> …` body quote and `<mx-reply>` block a reply carries for `target`. */
function replyFallback(
  room: Room,
  messageId: string,
  sender: string,
  target: MatrixEvent,
  contentOf: (event: MatrixEvent) => Record<string, unknown>,
): { body: string; html: string } {
  const origBody = stripReplyFallbackText(
    (contentOf(target)['body'] as string) ?? '',
  );
  const firstLine = origBody.split('\n')[0] ?? '';
  // Escape the ids interpolated into href attributes: a hostile sender/room id must not break
  // out of the attribute and inject markup.
  const roomLink = `https://matrix.to/#/${escapeHtml(room.roomId)}/${escapeHtml(messageId)}`;
  const userLink = `https://matrix.to/#/${escapeHtml(sender)}`;
  return {
    body: `> <${sender}> ${firstLine}\n\n`,
    html:
      `<mx-reply><blockquote>` +
      `<a href="${roomLink}">In reply to</a> ` +
      `<a href="${userLink}">${escapeHtml(sender)}</a><br>` +
      `${escapeHtml(firstLine)}</blockquote></mx-reply>`,
  };
}

/** `eventId` from the server, decrypted; undefined when it cannot be had. */
export async function fetchRoomEvent(
  client: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<MatrixEvent | undefined> {
  try {
    const raw = await client.fetchRoomEvent(roomId, eventId);
    if (raw.room_id && raw.room_id !== roomId) return undefined;
    const event = client.getEventMapper({ decrypt: false })({
      ...raw,
      room_id: roomId,
    });
    if (event.isEncrypted()) await client.decryptEventIfNeeded(event);
    return event;
  } catch {
    return undefined;
  }
}

/**
 * The ids of the current user's own live reaction events for a key on a message. Usually one,
 * but two devices can each send one, and un-reacting must remove them all.
 */
export function myReactionIds(
  client: MatrixClient,
  room: Room,
  messageId: string,
  key: string,
): string[] {
  const annotations = room.relations
    .getChildEventsForEvent(
      messageId,
      RelationType.Annotation,
      EventType.Reaction,
    )
    ?.getSortedAnnotationsByKey();
  const match = annotations?.find(([k]) => k === key);
  if (!match) {
    return [];
  }
  const myId = client.getUserId();
  return [...match[1]].flatMap((e) => {
    const id = e.getId();
    return id && !e.isRedacted() && e.getSender() === myId ? [id] : [];
  });
}

const TEXT_KEYS = ['msgtype', 'body', 'format', 'formatted_body'];
const MEDIA_KEYS = [...TEXT_KEYS, 'filename'];
/** The `info` and `thumbnail_info` fields a forward keeps: what the timeline reads to show media. */
const INFO_KEYS = ['mimetype', 'size', 'w', 'h', 'duration'];

/**
 * The content keys a forward keeps, by msgtype. A forward is the forwarder's own message, so
 * nothing the original sender added outside its type's fields comes along.
 */
const FORWARDED_KEYS = new Map<string, readonly string[]>([
  [MsgType.Text, TEXT_KEYS],
  [MsgType.Notice, TEXT_KEYS],
  [MsgType.Emote, TEXT_KEYS],
  [MsgType.Image, MEDIA_KEYS],
  [MsgType.File, MEDIA_KEYS],
  [MsgType.Video, MEDIA_KEYS],
  [MsgType.Audio, [...MEDIA_KEYS, MSC3245_VOICE, MSC1767_AUDIO]],
]);
const STICKER_KEYS = ['body'];

function pick(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  if (value && typeof value === 'object') {
    for (const key of keys) {
      if (Object.hasOwn(value, key)) {
        picked[key] = (value as Record<string, unknown>)[key];
      }
    }
  }
  return picked;
}

/**
 * A media message's source and info as the timeline shows them: its encrypted file when it
 * has a valid one, else its url, never both, and likewise for its thumbnail.
 */
function shownMedia(content: Record<string, unknown>): Record<string, unknown> {
  const rawInfo = content['info'];
  const info = pick(rawInfo, INFO_KEYS);
  const raw = pick(rawInfo, [
    'thumbnail_file',
    'thumbnail_url',
    'thumbnail_info',
  ]);
  const thumbnailFile = asEncryptedFile(raw['thumbnail_file']);
  if (thumbnailFile) {
    info['thumbnail_file'] = thumbnailFile;
  } else if (typeof raw['thumbnail_url'] === 'string') {
    info['thumbnail_url'] = raw['thumbnail_url'];
  }
  if (raw['thumbnail_info'] && typeof raw['thumbnail_info'] === 'object') {
    info['thumbnail_info'] = pick(raw['thumbnail_info'], INFO_KEYS);
  }
  const file = asEncryptedFile(content['file']);
  return {
    ...(file
      ? { file }
      : typeof content['url'] === 'string'
        ? { url: content['url'] }
        : {}),
    ...(rawInfo !== undefined ? { info } : {}),
  };
}

/**
 * The content to send for a forward of an event of `type`, or null when Trinity cannot forward
 * that type faithfully.
 *
 * `m.mentions` is always empty: recipients' push rules read it, so copying it would have the
 * forwarder ping whoever, or `@room`, the original sender listed.
 */
export function forwardedContent(
  type: string,
  content: Record<string, unknown>,
  /** Whether the original is a reply: an edit's content carries no relation of its own. */
  isReply: boolean,
): Record<string, unknown> | null {
  if (
    type === EventType.RoomMessage &&
    content['msgtype'] === MsgType.Location
  ) {
    // Rebuilt from the point and label the row shows, so no other field can disagree with them.
    const geo = parseGeoUri(content['geo_uri']);
    const label = content['body'];
    return geo
      ? {
          ...locationMessageContent(
            geo.lat,
            geo.lng,
            typeof label === 'string' ? label : undefined,
          ),
          'm.mentions': {},
        }
      : null;
  }
  const keys =
    type === EventType.Sticker
      ? STICKER_KEYS
      : type === EventType.RoomMessage && typeof content['msgtype'] === 'string'
        ? FORWARDED_KEYS.get(content['msgtype'])
        : undefined;
  if (!keys) {
    return null;
  }
  const forwarded: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(content, key)) {
      forwarded[key] = content[key];
    }
  }
  // Every type but text is media.
  if (keys !== TEXT_KEYS) {
    Object.assign(forwarded, shownMedia(content));
  }
  // The timeline hides a reply's fallback quote, so the forwarder never saw it, and without the
  // relation it would show in the target room as the message's own words.
  if (isReply) {
    if (typeof forwarded['body'] === 'string') {
      forwarded['body'] = stripReplyFallbackText(forwarded['body']);
    }
    if (typeof forwarded['formatted_body'] === 'string') {
      forwarded['formatted_body'] = stripReplyFallbackHtml(
        forwarded['formatted_body'],
      );
    }
  }
  forwarded['m.mentions'] = {};
  return forwarded;
}

/** File extension for a recorded voice clip's MIME type (best-effort, default webm). */
export function voiceExtension(mimeType: string): string {
  if (mimeType.includes('ogg')) {
    return 'ogg';
  }
  if (mimeType.includes('mp4') || mimeType.includes('mpeg')) {
    return 'm4a';
  }
  return 'webm';
}
