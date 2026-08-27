import { Injectable, inject } from '@angular/core';
import { EventType } from 'matrix-js-sdk';
import { Observable, defer, from, map, of, switchMap, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MediaService } from '@trinity/data-access/media';
import { type VoiceRecording } from '@trinity/platform-native';
import {
  annotationContent,
  editMessageContent,
  locationMessageContent,
  mediaCaptionFields,
  myReactionId,
  pollEndContent,
  pollResponseContent,
  pollStartContent,
  renderMarkdown,
  replyMessageContent,
  slashCommandContent,
  textMessageContent,
  voiceMessageContent,
  type Mention,
} from '@trinity/util/matrix';
import { TimelineService, type TimelineContext } from './timeline.service';

declare const locationShareTargetBrand: unique symbol;

/** Opaque one-shot binding to the room and account where location sharing began. */
export interface LocationShareTarget {
  readonly roomId: string;
  readonly [locationShareTargetBrand]: true;
}

export const LOCATION_TARGET_CHANGED_MESSAGE =
  'Location wasn’t shared because you changed rooms or accounts.';

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
 * Everything the user *writes* to a room's timeline: messages, replies, edits,
 * redactions, reactions, polls, attachments, voice clips, shared locations and
 * forwards.
 *
 * The counterpart to {@link TimelineService}, which projects the open room and owns
 * every listener; nothing here subscribes to the SDK or holds room state. The open
 * room is asked for on subscribe via {@link TimelineService.openContext}, so there is
 * one answer to "which room, on which account" rather than two.
 *
 * Every send method returns a COLD Observable: nothing is sent until someone
 * subscribes, and the room + account are normally resolved at that moment. Location
 * sharing is deliberately different: resolving a position may outlive navigation, so
 * it uses an opaque one-shot target captured before the asynchronous request and
 * refuses to send if that exact room/account is no longer active.
 */
@Injectable({ providedIn: 'root' })
export class TimelineActionsService {
  private readonly timeline = inject(TimelineService);
  private readonly mediaSvc = inject(MediaService);
  private readonly locationTargets = new WeakMap<
    LocationShareTarget,
    TimelineContext
  >();
  // Only forwardMessage needs this: it targets ANOTHER room, so there is no open-room
  // context to resolve and it has to reach the client directly.
  private readonly matrix = inject(MatrixClientService);

  /**
   * Send a message to the active room. Markdown is rendered to HTML, sanitized,
   * and sent as `formatted_body` — but only when it actually adds formatting; plain
   * text is sent as-is. The local echo appears via the timeline listener.
   */
  send(body: string, mentions: Mention[] = []): Observable<void> {
    const text = body.trim();
    return defer(() => {
      const ctx = this.timeline.openContext();
      if (!ctx || !text) {
        return of(void 0);
      }
      const { client, room } = ctx;
      // A leading slash command (/me, /shrug, /plain, /spoiler) rewrites the content;
      // otherwise build the normal text content (rather than sendText/HtmlMessage) so
      // mentions carry `m.mentions` + matrix.to pills. The SDK creates the local echo.
      const content =
        slashCommandContent(text, renderMarkdown, mentions) ??
        textMessageContent(text, renderMarkdown(text), mentions);
      return from(client.sendMessage(room.roomId, content as never));
    }).pipe(map(() => void 0));
  }

  /** Capture the exact room/account that initiated an asynchronous location share. */
  captureLocationTarget(): LocationShareTarget | null {
    const context = this.timeline.openContext();
    if (!context) {
      return null;
    }
    const target = Object.freeze({
      roomId: context.room.roomId,
    }) as LocationShareTarget;
    this.locationTargets.set(target, context);
    return target;
  }

  /** Whether a captured target is still the exact active room on the same account. */
  isLocationTargetCurrent(target: LocationShareTarget): boolean {
    const captured = this.locationTargets.get(target);
    const current = this.timeline.openContext();
    return Boolean(
      captured &&
      current &&
      current.client === captured.client &&
      current.room === captured.room,
    );
  }

  /** Send `m.location` only to its captured room/account; each target is one-shot. */
  sendLocationToTarget(
    target: LocationShareTarget,
    lat: number,
    lng: number,
  ): Observable<void> {
    return defer(() => {
      const captured = this.locationTargets.get(target);
      const current = this.timeline.openContext();
      this.locationTargets.delete(target);
      if (
        !captured ||
        !current ||
        current.client !== captured.client ||
        current.room !== captured.room
      ) {
        return throwError(() => new Error(LOCATION_TARGET_CHANGED_MESSAGE));
      }
      return from(
        captured.client.sendMessage(
          captured.room.roomId,
          locationMessageContent(lat, lng) as never,
        ),
      ).pipe(map(() => void 0));
    });
  }

  /**
   * Upload a recorded clip and send it as an MSC3245 voice message (an `m.audio`
   * with the voice marker + waveform), encrypting the bytes first in an E2EE room.
   * Cold — runs on subscribe.
   */
  sendVoiceMessage(recording: VoiceRecording): Observable<void> {
    return defer(() => {
      const ctx = this.timeline.openContext();
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
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      const client = this.matrix.instance;
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
      const ctx = this.timeline.openContext();
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
      const ctx = this.timeline.openContext();
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
      const ctx = this.timeline.openContext();
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
      const ctx = this.timeline.openContext();
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

  /** Edit a previously-sent message via an `m.replace` relation. */
  edit(
    messageId: string,
    newBody: string,
    mentions: Mention[] = [],
  ): Observable<void> {
    const text = newBody.trim();
    return defer(() => {
      const ctx = this.timeline.openContext();
      if (!ctx || !text) {
        return of(void 0);
      }
      const { client, room } = ctx;
      const content = editMessageContent(
        messageId,
        text,
        renderMarkdown(text),
        mentions,
      );
      // `content` is a valid m.replace payload; the SDK's content union doesn't
      // model it, so assert past it.
      return from(client.sendMessage(room.roomId, content as never));
    }).pipe(map(() => void 0));
  }

  /** Resend a message that failed to send. */
  retry(messageId: string): void {
    const ctx = this.timeline.openContext();
    if (!ctx) {
      return;
    }
    const event = ctx.room
      .getLiveTimeline()
      .getEvents()
      .find((e) => e.getId() === messageId);
    if (event) {
      ctx.client.resendEvent(event, ctx.room).catch(() => undefined);
    }
  }

  /** Send a reply to a message (`m.in_reply_to`), with a plain-text quote fallback. */
  reply(
    messageId: string,
    body: string,
    mentions: Mention[] = [],
  ): Observable<void> {
    const text = body.trim();
    return defer(() => {
      const ctx = this.timeline.openContext();
      if (!ctx || !text) {
        return of(void 0);
      }
      const { client, room } = ctx;
      const content = replyMessageContent(
        room,
        messageId,
        text,
        renderMarkdown(text),
        mentions,
      );
      return from(client.sendMessage(room.roomId, content as never));
    }).pipe(map(() => void 0));
  }

  /** Delete (redact) a message. */
  redact(messageId: string): Observable<void> {
    return defer(() => {
      const ctx = this.timeline.openContext();
      if (!ctx) {
        return of(void 0);
      }
      return from(ctx.client.redactEvent(ctx.room.roomId, messageId));
    }).pipe(map(() => void 0));
  }

  /**
   * Toggle the current user's reaction to a message: add the `m.annotation` if it
   * isn't there yet, otherwise redact their existing one.
   */
  toggleReaction(messageId: string, key: string): Observable<void> {
    return defer(() => {
      const ctx = this.timeline.openContext();
      if (!ctx) {
        return of(void 0);
      }
      const { client, room } = ctx;
      const mine = myReactionId(client, room, messageId, key);
      if (mine) {
        return from(client.redactEvent(room.roomId, mine));
      }
      return from(
        client.sendEvent(
          room.roomId,
          EventType.Reaction,
          annotationContent(messageId, key) as never,
        ),
      );
    }).pipe(map(() => void 0));
  }
}
