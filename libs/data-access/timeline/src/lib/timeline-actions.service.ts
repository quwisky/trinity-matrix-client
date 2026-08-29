import { Injectable, inject } from '@angular/core';
import { EventType } from 'matrix-js-sdk';
import { Observable, defer, from, map, of, switchMap, throwError } from 'rxjs';
import { MediaService, type ImagePackImage } from '@trinity/data-access/media';
import { type VoiceRecording } from '@trinity/platform-native';
import {
  locationMessageContent,
  mediaCaptionFields,
  pollEndContent,
  pollResponseContent,
  pollStartContent,
  voiceMessageContent,
} from '@trinity/util/matrix';
import { ConversationActionContextService } from './conversation-action-context.service';

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
 * The counterpart to the Conversation Runtime's timeline projection, which owns
 * every listener; nothing here subscribes to the SDK or holds room state. The open
 * room is asked for on subscribe through the runtime's internal action context, so there is
 * one answer to "which room, on which account" rather than two.
 *
 * Every method returns a COLD Observable: nothing is sent until someone subscribes,
 * and the focused Conversation is resolved at that moment. An action built before
 * focus changes (or replayed by a retry operator) therefore uses the then-focused
 * immutable Account-and-Room handle, never a captured route or global client pointer.
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
      const encrypt = room.hasEncryptionStateEvent();
      const file = new File(
        [recording.blob],
        `voice-message.${voiceExtension(recording.mimeType)}`,
        { type: recording.mimeType },
      );
      return this.mediaSvc.uploadMedia(file, encrypt).pipe(
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
   * Forward a message to another room: copy its content — dropping any reply/edit/thread
   * relation so it lands as a standalone message — and send it there. Works across rooms
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
      const content = { ...event.getContent() };
      delete content['m.relates_to'];
      delete content['m.new_content'];
      return from(client.sendMessage(targetRoomId, content as never));
    }).pipe(map(() => void 0));
  }

  /** Start a single-select poll (MSC3381) in the open room. Cold: runs on subscribe. */
  createPoll(question: string, options: string[]): Observable<void> {
    return defer(() => {
      const ctx = this.actionContext.resolve();
      const clean = options.map((o) => o.trim()).filter(Boolean);
      if (!ctx || !question.trim() || clean.length < 2) {
        return of(void 0);
      }
      return from(
        ctx.client.sendEvent(
          ctx.room.roomId,
          'm.poll.start' as never,
          pollStartContent(question.trim(), clean) as never,
        ),
      );
    }).pipe(map(() => void 0));
  }

  /** Cast (or change) the local user's vote on a poll. Cold: runs on subscribe. */
  votePoll(pollId: string, answerId: string): Observable<void> {
    return defer(() => {
      const ctx = this.actionContext.resolve();
      if (!ctx) {
        return of(void 0);
      }
      return from(
        ctx.client.sendEvent(
          ctx.room.roomId,
          'm.poll.response' as never,
          pollResponseContent(pollId, answerId) as never,
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
          'm.poll.end' as never,
          pollEndContent(pollId) as never,
        ),
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
    caption: string,
    progress?: (fraction: number) => void,
  ): Observable<void> {
    return defer(() => {
      const ctx = this.actionContext.resolve();
      if (!ctx || !file || file.size === 0) {
        return of(void 0);
      }
      const { client, room } = ctx;
      // Read on subscribe too: a room can become encrypted while an unsent action
      // is held, and uploading plaintext bytes into an E2EE room is not recoverable.
      const encrypt = room.hasEncryptionStateEvent();
      return this.mediaSvc.uploadMedia(file, encrypt, progress).pipe(
        switchMap((media) => {
          const content = {
            msgtype: media.msgtype,
            ...mediaCaptionFields(media.body, caption),
            info: media.info,
            ...(media.file ? { file: media.file } : { url: media.mxc }),
          };
          // A valid media payload; the SDK's content union doesn't model it.
          return from(client.sendMessage(room.roomId, content as never));
        }),
      );
    }).pipe(map(() => void 0));
  }
}
