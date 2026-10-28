import { Injectable, inject } from '@angular/core';
import {
  EventType,
  M_POLL_END,
  M_POLL_RESPONSE,
  M_POLL_START,
  MsgType,
} from 'matrix-js-sdk';
import { Observable, defer, from, map, of, switchMap, throwError } from 'rxjs';
import { MediaService, type ImagePackImage } from '@trinity/data-access/media';
import { type VoiceRecording } from '@trinity/platform-native';
import {
  MSC1767_AUDIO,
  MSC3245_VOICE,
  asEncryptedFile,
  isRoomEncrypted,
  locationMessageContent,
  parseGeoUri,
  pollEndContent,
  pollResponseContent,
  pollStartContent,
  stripReplyFallbackHtml,
  stripReplyFallbackText,
  voiceMessageContent,
} from '@trinity/util/matrix';
import { ConversationActionContextService } from './conversation-action-context.service';
import { shownContent } from './js-sdk/shields';

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
function forwardedContent(
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
function voiceExtension(mimeType: string): string {
  if (mimeType.includes('ogg')) {
    return 'ogg';
  }
  if (mimeType.includes('mp4') || mimeType.includes('mpeg')) {
    return 'm4a';
  }
  return 'webm';
}

/**
 * Transitional non-message writes to a room's timeline: polls, attachments, voice clips,
 * shared locations and forwards. Message relations and actions belong to each immutable
 * Conversation handle's typed `messages` surface.
 *
 * The counterpart to the Conversation Runtime's timeline projection, which owns every
 * listener; nothing here subscribes to the SDK or holds room state. The open room is asked
 * for on subscribe through the runtime's internal action context, so there is one answer
 * to "which room, on which account".
 *
 * Every method returns a COLD Observable: nothing is sent until someone subscribes, and
 * the focused Conversation is resolved then. An action built before focus changes (or
 * replayed by a retry operator) therefore uses the then-focused immutable Account-and-Room
 * handle, never a captured route or global client pointer.
 */
@Injectable({ providedIn: 'root' })
export class TimelineActionsService {
  private readonly actionContext = inject(ConversationActionContextService);
  private readonly mediaSvc = inject(MediaService);

  /** Send a shared location (`m.location`) to the active room. Cold — runs on subscribe. */
  sendLocation(lat: number, lng: number): Observable<void> {
    return defer(() => {
      const ctx = this.actionContext.resolve();
      if (!ctx) {
        return of(void 0);
      }
      const { client, room } = ctx;
      return from(
        client.sendMessage(
          room.roomId,
          locationMessageContent(lat, lng) as never,
        ),
      ).pipe(map(() => void 0));
    });
  }

  /** Send an MSC2545 image-pack entry as a standalone `m.sticker` event. */
  sendSticker(sticker: ImagePackImage): Observable<void> {
    return defer(() => {
      const ctx = this.actionContext.resolve();
      if (
        !ctx ||
        !sticker.usage.includes('sticker') ||
        !/^mxc:\/\/[^/\s]+\/[^\s]+$/.test(sticker.url)
      ) {
        return of(void 0);
      }
      return from(
        ctx.client.sendEvent(ctx.room.roomId, EventType.Sticker, {
          body: sticker.body || sticker.shortcode,
          url: sticker.url,
          info: sticker.info,
        }),
      );
    }).pipe(map(() => void 0));
  }

  /**
   * Upload a recorded clip and send it as an MSC3245 voice message (an `m.audio`
   * with the voice marker + waveform), encrypting the bytes first in an E2EE room.
   * Cold — runs on subscribe.
   */
  sendVoiceMessage(recording: VoiceRecording): Observable<void> {
    return defer(() => {
      const ctx = this.actionContext.resolve();
      if (!ctx || recording.blob.size === 0) {
        return of(void 0);
      }
      const { client, room } = ctx;
      const crypto = client.getCrypto?.();
      const file = new File(
        [recording.blob],
        `voice-message.${voiceExtension(recording.mimeType)}`,
        { type: recording.mimeType },
      );
      return from(isRoomEncrypted(room, crypto)).pipe(
        switchMap((encrypt) => {
          // Without a crypto store the SDK would send the event, and the clip's key, in the clear.
          if (encrypt && !crypto) {
            throw new Error('Encryption is unavailable.');
          }
          return this.mediaSvc.uploadMedia(file, encrypt);
        }),
        switchMap((media) =>
          from(
            client.sendMessage(
              room.roomId,
              voiceMessageContent(
                {
                  mxc: media.mxc,
                  file: media.file,
                  mimeType: media.info.mimetype,
                  size: media.info.size,
                },
                recording.durationMs,
                recording.waveform,
              ) as never,
            ),
          ),
        ),
      );
    }).pipe(map(() => void 0));
  }

  /**
   * Forward a message to another room: copy its type's content fields — dropping any
   * reply/edit/thread relation so it lands as a standalone message, and mentioning nobody —
   * and send it there. Errors for a type it cannot forward (a poll, say). Works across rooms
   * and for media (an encrypted attachment carries its own key in the content, so the
   * target room's members can still decrypt it). Cold: runs on subscribe.
   */
  forwardMessage(
    sourceRoomId: string,
    eventId: string,
    targetRoomId: string,
  ): Observable<void> {
    return defer(() => {
      const ctx = this.actionContext.resolve();
      if (!ctx) {
        return throwError(() => new Error('Not signed in.'));
      }
      const { client } = ctx;
      const event = client.getRoom(sourceRoomId)?.findEventById(eventId);
      if (!event) {
        return throwError(() => new Error('Message not found.'));
      }
      // What the row shows (an encrypted edit only once its own shield is checked), cut to
      // the message's own fields.
      const forwarded = forwardedContent(
        event.getType(),
        shownContent(event),
        Boolean(event.replyEventId),
      );
      if (!forwarded) {
        return throwError(() => new Error('This message cannot be forwarded.'));
      }
      return from(
        event.getType() === EventType.Sticker
          ? client.sendEvent(
              targetRoomId,
              EventType.Sticker,
              forwarded as never,
            )
          : client.sendMessage(targetRoomId, forwarded as never),
      );
    }).pipe(map(() => void 0));
  }

  /**
   * Start a poll (MSC3381) in the open room letting each voter choose up to
   * `maxSelections` answers (clamped to the answer count). Cold: runs on subscribe.
   */
  createPoll(
    question: string,
    options: string[],
    maxSelections = 1,
  ): Observable<void> {
    return defer(() => {
      const ctx = this.actionContext.resolve();
      const clean = options.map((o) => o.trim()).filter(Boolean);
      if (!ctx || !question.trim() || clean.length < 2) {
        return of(void 0);
      }
      return from(
        ctx.client.sendEvent(
          ctx.room.roomId,
          M_POLL_START.name as never,
          pollStartContent(
            question.trim(),
            clean,
            Math.min(Math.max(Math.trunc(maxSelections), 1), clean.length),
          ) as never,
        ),
      );
    }).pipe(map(() => void 0));
  }

  /**
   * Cast (or change) the local user's vote on a poll; an empty `answerIds` withdraws it.
   * Cold: runs on subscribe.
   */
  votePoll(pollId: string, answerIds: readonly string[]): Observable<void> {
    return defer(() => {
      const ctx = this.actionContext.resolve();
      if (!ctx) {
        return of(void 0);
      }
      return from(
        ctx.client.sendEvent(
          ctx.room.roomId,
          M_POLL_RESPONSE.name as never,
          pollResponseContent(pollId, answerIds) as never,
        ),
      );
    }).pipe(map(() => void 0));
  }

  /** Close a poll so no further votes count (creator action). Cold: runs on subscribe. */
  endPoll(pollId: string): Observable<void> {
    return defer(() => {
      const ctx = this.actionContext.resolve();
      if (!ctx) {
        return of(void 0);
      }
      return from(
        ctx.client.sendEvent(
          ctx.room.roomId,
          M_POLL_END.name as never,
          pollEndContent(pollId) as never,
        ),
      );
    }).pipe(map(() => void 0));
  }
}
