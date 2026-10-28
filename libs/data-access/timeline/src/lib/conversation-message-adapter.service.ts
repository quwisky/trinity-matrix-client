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
import {
  DraftStoreService,
  PrivacySettingsService,
} from '@trinity/platform-native';
import {
  annotationContent,
  isTransientMatrixError,
} from '@trinity/util/matrix';
import type {
  ConversationMessageActionRequest,
  ConversationMessageAdapter,
  ConversationMessageOperation,
  ConversationMessageOutcome,
  ConversationMessagePolicy,
  ConversationReactionRequest,
} from './conversation-messages';
import { myReactionIds } from './js-sdk/outgoing-content';
import { transactionIdOf } from './js-sdk/timeline-item';
import { conversationDraftKey, threadDraftKey } from './conversation-draft-key';

const unavailablePolicy: ConversationMessagePolicy = {
  canRedactOthers: () => false,
  canSendMessages: () => true,
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
  private readonly drafts = inject(DraftStoreService);
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
      if (!this.event(room, request.messageId, request.threadRootId)) {
        return of(this.rejected('reaction', 'message-unavailable'));
      }
      const mine = myReactionIds(client, room, request.messageId, reaction);
      const action = mine.length
        ? Promise.all(
            mine.map((id) =>
              request.threadRootId
                ? client.redactEvent(room.roomId, request.threadRootId, id)
                : client.redactEvent(room.roomId, id),
            ),
          )
        : request.threadRootId
          ? client.sendEvent(
              room.roomId,
              request.threadRootId,
              EventType.Reaction,
              annotationContent(request.messageId, reaction) as never,
            )
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
      const action = request.threadRootId
        ? context.client.redactEvent(
            context.room.roomId,
            request.threadRootId,
            request.messageId,
          )
        : context.client.redactEvent(context.room.roomId, request.messageId);
      return from(action).pipe(
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
      const event = this.event(
        context.room,
        request.messageId,
        request.threadRootId,
      );
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

  cancel(
    request: ConversationMessageActionRequest,
  ): Observable<ConversationMessageOutcome> {
    return defer(() => {
      const context = this.context(request);
      if (!context) {
        return of(this.rejected('cancel', 'conversation-unavailable'));
      }
      const event = this.event(
        context.room,
        request.messageId,
        request.threadRootId,
      );
      if (!event) return of(this.rejected('cancel', 'message-unavailable'));
      if (event.status !== EventStatus.NOT_SENT) {
        return of(this.rejected('cancel', 'event-not-retryable'));
      }
      // CANCELLED stops the reconnect resend; the text held for a reload goes with it.
      context.client.cancelPendingEvent(event);
      const transactionId = transactionIdOf(event);
      if (transactionId) {
        this.drafts.releaseWaiting(
          request.threadRootId
            ? threadDraftKey(request.threadRootId)
            : conversationDraftKey(request.key),
          transactionId,
        );
      }
      return of(this.applied('cancel'));
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
      const event = this.event(
        context.room,
        request.messageId,
        request.threadRootId,
      );
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
      if (
        !request.threadRootId &&
        typeof context.client.setRoomReadMarkers === 'function'
      ) {
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

  private event(room: Room, messageId: string, threadRootId?: string) {
    return (
      room.findEventById?.(messageId) ??
      room
        .getThread?.(threadRootId ?? '')
        ?.events.find((event) => event.getId() === messageId) ??
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
