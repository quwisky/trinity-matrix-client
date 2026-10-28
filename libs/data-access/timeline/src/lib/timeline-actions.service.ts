import { Injectable, inject } from '@angular/core';
import { Observable, defer, map, of, throwError } from 'rxjs';
import { type ImagePackImage } from '@trinity/data-access/media';
import { type VoiceRecording } from '@trinity/platform-native';
import {
  EngineRequestError,
  NOT_SIGNED_IN,
  type EngineResult,
  unwrapEngineResult,
} from '@trinity/util/matrix';
import { ConversationActionContextService } from './conversation-action-context.service';
import type { OutgoingMessage } from './timeline-engine';
import { TIMELINE_ENGINE } from './timeline-engine.token';

const NO_RELATION = { threadRootId: null, replyTo: null } as const;

/**
 * Transitional non-message writes to a room's timeline: polls, attachments, voice clips,
 * shared locations and forwards. Message relations and actions belong to each immutable
 * Conversation handle's typed `messages` surface.
 *
 * The counterpart to the Conversation Runtime's timeline projection, which owns every
 * listener; nothing here subscribes to the timeline or holds room state. The open room is
 * asked for on subscribe through the runtime's internal action context, so there is one
 * answer to "which room, on which account".
 *
 * Every method returns a COLD Observable: nothing is sent until someone subscribes, and
 * the focused Conversation is resolved then. An action built before focus changes (or
 * replayed by a retry operator) therefore uses the then-focused immutable Account-and-Room
 * handle, never a captured route or global client pointer.
 */
@Injectable({ providedIn: 'root' })
export class TimelineActionsService {
  private readonly actionContext = inject(ConversationActionContextService);
  private readonly engine = inject(TIMELINE_ENGINE);

  /** Send a shared location (`m.location`) to the active room. Cold — runs on subscribe. */
  sendLocation(lat: number, lng: number): Observable<void> {
    return this.send({ kind: 'location', lat, lng, label: null });
  }

  /** Send an MSC2545 image-pack entry as a standalone `m.sticker` event. */
  sendSticker(sticker: ImagePackImage): Observable<void> {
    if (
      !sticker.usage.includes('sticker') ||
      !/^mxc:\/\/[^/\s]+\/[^\s]+$/.test(sticker.url)
    ) {
      return of(void 0);
    }
    return this.send({
      kind: 'sticker',
      body: sticker.body || sticker.shortcode,
      url: sticker.url,
      info: sticker.info,
    });
  }

  /**
   * Upload a recorded clip and send it as an MSC3245 voice message (an `m.audio`
   * with the voice marker + waveform), encrypting the bytes first in an E2EE room.
   * Cold — runs on subscribe.
   */
  sendVoiceMessage(recording: VoiceRecording): Observable<void> {
    return defer(() => {
      const key = this.actionContext.resolve();
      if (!key || recording.blob.size === 0) {
        return of(void 0);
      }
      return this.engine.sendVoice(key.accountId, key.roomId, recording).pipe(
        unwrapEngineResult(),
        map(() => void 0),
      );
    });
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
      const key = this.actionContext.resolve();
      if (!key) {
        return throwError(() => new EngineRequestError(NOT_SIGNED_IN));
      }
      return this.engine
        .forward(key.accountId, sourceRoomId, eventId, targetRoomId)
        .pipe(
          unwrapEngineResult(),
          map(() => void 0),
        );
    });
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
    const clean = options.map((o) => o.trim()).filter(Boolean);
    if (!question.trim() || clean.length < 2) {
      return of(void 0);
    }
    return this.send({
      kind: 'poll-start',
      question: question.trim(),
      answers: clean,
      maxSelections: Math.min(
        Math.max(Math.trunc(maxSelections), 1),
        clean.length,
      ),
    });
  }

  /**
   * Cast (or change) the local user's vote on a poll; an empty `answerIds` withdraws it.
   * Cold: runs on subscribe.
   */
  votePoll(pollId: string, answerIds: readonly string[]): Observable<void> {
    return this.send({ kind: 'poll-response', pollId, answerIds });
  }

  /** Close a poll so no further votes count (creator action). Cold: runs on subscribe. */
  endPoll(pollId: string): Observable<void> {
    return this.send({ kind: 'poll-end', pollId });
  }

  /** Sends `message` to the focused room, or nothing when no Conversation is focused. */
  private send(message: OutgoingMessage): Observable<void> {
    return defer(() => {
      const key = this.actionContext.resolve();
      if (!key) {
        return of(void 0);
      }
      return this.engine
        .send(key.accountId, key.roomId, message, NO_RELATION)
        .pipe(map(delivered));
    });
  }
}

/** A send whose echo stayed unsent fails the action, as the SDK's rejected send did. */
function delivered(
  result: EngineResult<{ readonly eventId: string | null }>,
): void {
  if (!result.ok) throw new EngineRequestError(result.failure);
  if (result.value.eventId === null)
    throw new Error('The message was not sent.');
}
