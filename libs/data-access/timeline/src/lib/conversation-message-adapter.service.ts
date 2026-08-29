import { Injectable, InjectionToken, inject } from '@angular/core';
import { EventStatus, EventType, ReceiptType, type Room } from 'matrix-js-sdk';
import {
  catchError,
  defer,
  forkJoin,
  from,
  map,
  of,
  type Observable,
} from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { PrivacySettingsService } from '@trinity/platform-native';
import {
  annotationContent,
  isTransientMatrixError,
  myReactionId,
} from '@trinity/util/matrix';
import type {
  ConversationMessageActionRequest,
  ConversationMessageAdapter,
  ConversationMessageOperation,
  ConversationMessageOutcome,
  ConversationMessagePolicy,
  ConversationReactionRequest,
} from './conversation-messages';

const unavailablePolicy: ConversationMessagePolicy = {
  canRedactOthers: () => false,
  authorizeRedaction: () => ({
    kind: 'rejected',
    failure: 'conversation-unavailable',
  }),
};

export const CONVERSATION_MESSAGE_POLICY =
  new InjectionToken<ConversationMessagePolicy>(
    'conversation-runtime.room-administration-message-policy',
    { providedIn: 'root', factory: () => unavailablePolicy },
  );

@Injectable({ providedIn: 'root' })
class MatrixConversationMessageAdapter implements ConversationMessageAdapter {
  private readonly matrix = inject(MatrixClientService);
  private readonly privacy = inject(PrivacySettingsService);
  private readonly policy = inject(CONVERSATION_MESSAGE_POLICY);

  toggleReaction(
    request: ConversationReactionRequest,
  ): Observable<ConversationMessageOutcome> {
    return defer(() => {
      const context = this.context(request);
      const reaction = request.reaction.trim();
      if (!reaction) return of(this.rejected('reaction', 'invalid-reaction'));
      if (!context) {
        return of(this.rejected('reaction', 'conversation-unavailable'));
      }
      const { client, room } = context;
      if (!this.event(room, request.messageId)) {
        return of(this.rejected('reaction', 'message-unavailable'));
      }
      const mine = myReactionId(client, room, request.messageId, reaction);
      const action = mine
        ? client.redactEvent(room.roomId, mine)
        : client.sendEvent(
            room.roomId,
            EventType.Reaction,
            annotationContent(request.messageId, reaction) as never,
          );
      return from(action).pipe(
        map(() => this.applied('reaction')),
        catchError((error: unknown) =>
          of(this.requestRejected('reaction', error)),
        ),
      );
    });
  }

  redact(
    request: ConversationMessageActionRequest,
  ): Observable<ConversationMessageOutcome> {
    return defer(() => {
      const decision = this.policy.authorizeRedaction(request);
      if (decision.kind === 'rejected') {
        return of(this.rejected('redaction', decision.failure));
      }
      const context = this.context(request);
      if (!context) {
        return of(this.rejected('redaction', 'conversation-unavailable'));
      }
      return from(
        context.client.redactEvent(context.room.roomId, request.messageId),
      ).pipe(
        map(() => this.applied('redaction')),
        catchError((error: unknown) =>
          of(this.requestRejected('redaction', error)),
        ),
      );
    });
  }

  retry(
    request: ConversationMessageActionRequest,
  ): Observable<ConversationMessageOutcome> {
    return defer(() => {
      const context = this.context(request);
      if (!context) {
        return of(this.rejected('retry', 'conversation-unavailable'));
      }
      const event = this.event(context.room, request.messageId);
      if (!event) return of(this.rejected('retry', 'message-unavailable'));
      if (
        event.status !== EventStatus.NOT_SENT &&
        event.status !== EventStatus.QUEUED &&
        event.status !== EventStatus.ENCRYPTING
      ) {
        return of(this.rejected('retry', 'event-not-retryable'));
      }
      return from(context.client.resendEvent(event, context.room)).pipe(
        map(() => this.applied('retry')),
        catchError((error: unknown) =>
          of(this.requestRejected('retry', error)),
        ),
      );
    });
  }

  acknowledge(
    request: ConversationMessageActionRequest,
  ): Observable<ConversationMessageOutcome> {
    return defer(() => {
      const context = this.context(request);
      if (!context) {
        return of(this.rejected('receipt', 'conversation-unavailable'));
      }
      const event = this.event(context.room, request.messageId);
      if (!event || event.status) {
        return of(this.rejected('receipt', 'message-unavailable'));
      }
      const receiptType = this.privacy.sendReadReceipts()
        ? ReceiptType.Read
        : ReceiptType.ReadPrivate;
      const operations: Observable<unknown>[] = [];
      if (typeof context.client.sendReadReceipt === 'function') {
        operations.push(
          defer(() => from(context.client.sendReadReceipt(event, receiptType))),
        );
      }
      if (typeof context.client.setRoomReadMarkers === 'function') {
        operations.push(
          defer(() =>
            from(
              context.client.setRoomReadMarkers(
                context.room.roomId,
                request.messageId,
              ),
            ),
          ),
        );
      }
      return (operations.length ? forkJoin(operations) : of([])).pipe(
        map(() => this.applied('receipt')),
        catchError((error: unknown) =>
          of(this.requestRejected('receipt', error)),
        ),
      );
    });
  }

  private context(request: ConversationMessageActionRequest) {
    const client = this.matrix.clientFor(request.key.accountId);
    const room = client?.getRoom(request.key.roomId) ?? null;
    return client && room ? { client, room } : null;
  }

  private event(room: Room, messageId: string) {
    return (
      room.findEventById?.(messageId) ??
      room
        .getLiveTimeline()
        .getEvents()
        .find((event) => event.getId() === messageId)
    );
  }

  private applied(
    operation: ConversationMessageOperation,
  ): ConversationMessageOutcome {
    return { kind: 'applied', operation };
  }

  private rejected(
    operation: ConversationMessageOperation,
    failure: Extract<
      ConversationMessageOutcome,
      { kind: 'rejected' }
    >['failure'],
  ): ConversationMessageOutcome {
    return { kind: 'rejected', operation, failure, retryable: false };
  }

  private requestRejected(
    operation: ConversationMessageOperation,
    error: unknown,
  ): ConversationMessageOutcome {
    return {
      kind: 'rejected',
      operation,
      failure: 'request-rejected',
      retryable: isTransientMatrixError(error),
    };
  }
}

export const CONVERSATION_MESSAGE_ADAPTER =
  new InjectionToken<ConversationMessageAdapter>(
    'conversation-runtime.message-adapter',
    {
      providedIn: 'root',
      factory: () => inject(MatrixConversationMessageAdapter),
    },
  );
