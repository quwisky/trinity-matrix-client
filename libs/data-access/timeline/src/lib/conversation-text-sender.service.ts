import { Injectable, InjectionToken, inject } from '@angular/core';
import { type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import {
  type Observable,
  catchError,
  defer,
  finalize,
  from,
  map,
  of,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import {
  editMessageContent,
  renderMarkdown,
  replyMessageContent,
  slashCommandContent,
  textMessageContent,
} from '@trinity/util/matrix';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ImagePackEditorService } from '@trinity/data-access/media';
import {
  type ConversationTextSendOperation,
  type ConversationTextSendRequest,
  type ConversationTextSender,
} from './conversation-compose';
import { shownContent } from './shields';

class MissingLocalEchoError extends Error {
  constructor() {
    super('The Matrix SDK accepted a message without exposing its local echo.');
  }
}

@Injectable({ providedIn: 'root' })
class MatrixConversationTextSender implements ConversationTextSender {
  private readonly matrix = inject(MatrixClientService);
  private readonly packs = inject(ImagePackEditorService);

  send(request: ConversationTextSendRequest): ConversationTextSendOperation {
    const client = this.matrix.clientFor(request.key.accountId);
    const room = client?.getRoom(request.key.roomId) ?? null;
    if (!client || !room || client.getUserId() !== request.key.accountId) {
      return this.settled(of({ kind: 'rejected', retryable: false }));
    }
    let localEventId: string | null = null;
    let fetchingTarget = false;
    let settled = false;
    const outcome = this.replyTarget(client, room, request, (fetching) => {
      fetchingTarget = fetching;
    }).pipe(
      switchMap((target) => {
        const content = this.content(request, room, target);
        const txnId = client.makeTxnId();
        localEventId = `~${room.roomId}:${txnId}`;
        return from(client.sendMessage(room.roomId, content as never, txnId));
      }),
      map(({ event_id }) => {
        if (!event_id || !room.findEventById(event_id)) {
          throw new MissingLocalEchoError();
        }
        return { kind: 'accepted' as const, eventId: event_id };
      }),
      catchError((error: unknown) =>
        error instanceof MissingLocalEchoError
          ? throwError(() => error)
          : of({ kind: 'rejected' as const, retryable: true }),
      ),
      tap({
        next: () => (settled = true),
        error: () => (settled = true),
      }),
    );
    return {
      outcome,
      cancel: () => {
        if (settled) return false;
        // Nothing has been sent while the reply target is still being fetched.
        if (fetchingTarget) {
          settled = true;
          return true;
        }
        const localEcho = localEventId
          ? room.findEventById(localEventId)
          : undefined;
        if (!localEcho) return false;
        try {
          client.cancelPendingEvent(localEcho);
          settled = true;
          return true;
        } catch {
          // SENDING means the request may already have crossed the network boundary. Treat
          // that as indeterminate rather than restoring text that could now be a duplicate.
          return false;
        }
      },
    };
  }

  private settled(
    outcome: ConversationTextSendOperation['outcome'],
  ): ConversationTextSendOperation {
    return { outcome, cancel: () => false };
  }

  /**
   * The event a reply quotes. A reply can outlive its target in memory: the compose intent
   * survives the handle, whose retirement trims the room's older history, and a draft
   * survives a restart. Such a target is fetched from the server; when that fails the reply
   * is still sent, keeping its relation but no quote.
   */
  private replyTarget(
    client: MatrixClient,
    room: Room,
    request: ConversationTextSendRequest,
    onFetching: (fetching: boolean) => void,
  ): Observable<MatrixEvent | undefined> {
    return defer(() => {
      if (request.intent.kind !== 'reply') return of(undefined);
      const { eventId } = request.intent;
      const loaded = room.findEventById(eventId);
      if (loaded) return of(loaded);
      onFetching(true);
      return from(fetchRoomEvent(client, room.roomId, eventId)).pipe(
        finalize(() => onFetching(false)),
      );
    });
  }

  private content(
    request: ConversationTextSendRequest,
    room: Room,
    target: MatrixEvent | undefined,
  ): object {
    const mentions = [...request.mentions];
    const emoticons = this.packs.emoticons();
    const render = (text: string) => renderMarkdown(text, emoticons);
    switch (request.intent.kind) {
      case 'message':
        return (
          slashCommandContent(request.body, render, mentions) ??
          textMessageContent(request.body, render(request.body), mentions)
        );
      case 'reply':
        return replyMessageContent(
          room,
          request.intent.eventId,
          request.body,
          render(request.body),
          mentions,
          target,
          shownContent,
        );
      case 'edit':
        return editMessageContent(
          request.intent.eventId,
          request.body,
          render(request.body),
          mentions,
        );
    }
  }
}

/** `eventId` from the server, decrypted; undefined when it cannot be had. */
async function fetchRoomEvent(
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

export const CONVERSATION_TEXT_SENDER =
  new InjectionToken<ConversationTextSender>(
    'conversation-runtime.text-sender',
    {
      providedIn: 'root',
      factory: () => inject(MatrixConversationTextSender),
    },
  );

export type { ConversationTextSender } from './conversation-compose';
