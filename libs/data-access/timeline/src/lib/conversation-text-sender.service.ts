import { Injectable, InjectionToken, inject } from '@angular/core';
import { Observable, catchError, defer, from, map, of, throwError } from 'rxjs';
import {
  editMessageContent,
  renderMarkdown,
  replyMessageContent,
  slashCommandContent,
  textMessageContent,
} from '@trinity/util/matrix';
import { ConversationActionContextService } from './conversation-action-context.service';
import {
  type ConversationTextDelivery,
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
  private readonly actionContext = inject(ConversationActionContextService);

  send(
    request: ConversationTextSendRequest,
  ): Observable<ConversationTextDelivery> {
    return defer(() => {
      const context = this.actionContext.resolve();
      if (
        !context ||
        context.client.getUserId() !== request.key.accountId ||
        context.room.roomId !== request.key.roomId
      ) {
        return of({ kind: 'rejected' as const, retryable: false });
      }
      const { client, room } = context;
      const content = this.content(request, room);
      return from(client.sendMessage(room.roomId, content as never)).pipe(
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
      );
    });
  }

  private content(
    request: ConversationTextSendRequest,
    room: NonNullable<
      ReturnType<ConversationActionContextService['resolve']>
    >['room'],
  ): object {
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
