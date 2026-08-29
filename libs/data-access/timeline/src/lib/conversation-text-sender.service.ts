import { Injectable, InjectionToken, inject } from '@angular/core';
import { type Room } from 'matrix-js-sdk';
import { catchError, defer, from, map, of, tap, throwError } from 'rxjs';
import {
  editMessageContent,
  renderMarkdown,
  replyMessageContent,
  slashCommandContent,
  textMessageContent,
} from '@trinity/util/matrix';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  type ConversationTextSendOperation,
  type ConversationTextSendRequest,
  type ConversationTextSender,
} from './conversation-compose';

class MissingLocalEchoError extends Error {
  constructor() {
    super('The Matrix SDK accepted a message without exposing its local echo.');
  }
}

@Injectable({ providedIn: 'root' })
class MatrixConversationTextSender implements ConversationTextSender {
  private readonly matrix = inject(MatrixClientService);

  send(request: ConversationTextSendRequest): ConversationTextSendOperation {
    const client = this.matrix.clientFor(request.key.accountId);
    const room = client?.getRoom(request.key.roomId) ?? null;
    if (!client || !room || client.getUserId() !== request.key.accountId) {
      return this.settled(of({ kind: 'rejected', retryable: false }));
    }
    const content = this.content(request, room);
    let localEventId: string | null = null;
    let settled = false;
    const outcome = defer(() => {
      const txnId = client.makeTxnId();
      localEventId = `~${room.roomId}:${txnId}`;
      return from(client.sendMessage(room.roomId, content as never, txnId));
    }).pipe(
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

  private content(request: ConversationTextSendRequest, room: Room): object {
    const mentions = [...request.mentions];
    switch (request.intent.kind) {
      case 'message':
        return (
          slashCommandContent(request.body, renderMarkdown, mentions) ??
          textMessageContent(
            request.body,
            renderMarkdown(request.body),
            mentions,
          )
        );
      case 'reply':
        return replyMessageContent(
          room,
          request.intent.eventId,
          request.body,
          renderMarkdown(request.body),
          mentions,
        );
      case 'edit':
        return editMessageContent(
          request.intent.eventId,
          request.body,
          renderMarkdown(request.body),
          mentions,
        );
    }
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
