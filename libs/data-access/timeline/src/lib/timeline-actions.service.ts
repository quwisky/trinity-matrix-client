import { Injectable, inject } from '@angular/core';
import {
  EventType,
  M_POLL_END,
  M_POLL_RESPONSE,
  M_POLL_START,
} from 'matrix-js-sdk';
import { Observable, defer, from, map, of, switchMap, throwError } from 'rxjs';
import { MediaService, type ImagePackImage } from '@trinity/data-access/media';
import { type VoiceRecording } from '@trinity/platform-native';
import {
  isRoomEncrypted,
  locationMessageContent,
  pollEndContent,
  pollResponseContent,
  pollStartContent,
  voiceMessageContent,
} from '@trinity/util/matrix';
import { ConversationActionContextService } from './conversation-action-context.service';
import { forwardedContent, voiceExtension } from './js-sdk/outgoing-content';
import { shownContent } from './js-sdk/shields';

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
