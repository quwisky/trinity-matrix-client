import { DestroyRef, Injectable, InjectionToken, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import {
  EventStatus,
  EventType,
  ReceiptType,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import {
  catchError,
  defer,
  forkJoin,
  from,
  map,
  of,
  ReplaySubject,
  take,
  type Observable,
} from 'rxjs';
import {
  MatrixClientService,
  unsentText,
} from '@trinity/data-access/matrix-client';
import {
  DraftStoreService,
  PrivacySettingsService,
} from '@trinity/platform-native';
import {
  annotationContent,
  isTransientMatrixError,
  isWaitingToSend,
  myReactionIds,
  resendAtEnd,
} from '@trinity/util/matrix';
import type {
  ConversationMessageActionRequest,
  ConversationMessageAdapter,
  ConversationMessageOperation,
  ConversationMessageOutcome,
  ConversationMessagePolicy,
  ConversationReactionRequest,
} from './conversation-messages';
import { conversationDraftKey, threadDraftKey } from './conversation-draft-key';
import { keepWhileWaiting } from './waiting-draft';

const unavailablePolicy: ConversationMessagePolicy = {
  canRedactOthers: () => false,
  canSendMessages: () => true,
  authorizeRedaction: () => ({
    kind: 'rejected',
    failure: 'conversation-unavailable',
  }),
};

/**
 * The SDK takes the thread overload only for a `$` event id; any other id (a pending local echo,
 * `~!room:txn`) shifts the arguments and redacts the thread root instead. So only a server id
 * gets the thread scope. A pending id takes the two-argument form, where the SDK throws
 * synchronously instead of sending a request; callers must not let that throw escape, and
 * `toggleReaction` skips pending ids altogether.
 */
function redactById(
  client: MatrixClient,
  roomId: string,
  threadRootId: string | undefined,
  eventId: string,
) {
  return threadRootId && eventId.startsWith('$')
    ? client.redactEvent(roomId, threadRootId, eventId)
    : client.redactEvent(roomId, eventId);
}

export const CONVERSATION_MESSAGE_POLICY =
  new InjectionToken<ConversationMessagePolicy>(
    'conversation-runtime.room-administration-message-policy',
    { providedIn: 'root', factory: () => unavailablePolicy },
  );

/** How long a read receipt waits for a newer one; 0 sends at once (specs that assert the send). */
export const READ_RECEIPT_DEBOUNCE_MS = new InjectionToken<number>(
  'conversation-runtime.read-receipt-debounce-ms',
  { providedIn: 'root', factory: () => 1_000 },
);

interface PendingReceipt {
  request: ConversationMessageActionRequest;
  readonly outcome: ReplaySubject<ConversationMessageOutcome>;
  readonly timer: ReturnType<typeof setTimeout>;
}

@Injectable({ providedIn: 'root' })
class MatrixConversationMessageAdapter implements ConversationMessageAdapter {
  private readonly matrix = inject(MatrixClientService);
  private readonly privacy = inject(PrivacySettingsService);
  private readonly drafts = inject(DraftStoreService);
  private readonly policy = inject(CONVERSATION_MESSAGE_POLICY);
  private readonly receiptDebounceMs = inject(READ_RECEIPT_DEBOUNCE_MS);
  private readonly pendingReceipts = new Map<string, PendingReceipt>();

  constructor() {
    const doc = inject(DOCUMENT);
    const onVisibility = (): void => {
      if (doc.visibilityState === 'hidden') this.flushReceipts();
    };
    doc.addEventListener('visibilitychange', onVisibility);
    inject(DestroyRef).onDestroy(() => {
      doc.removeEventListener('visibilitychange', onVisibility);
      this.flushReceipts();
    });
  }

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
            mine
              .filter((id) => id.startsWith('$'))
              .map((id) =>
                redactById(client, room.roomId, request.threadRootId, id),
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
      return defer(() =>
        redactById(
          context.client,
          context.room.roomId,
          request.threadRootId,
          request.messageId,
        ),
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
      return from(resendAtEnd(context.client, event, context.room)).pipe(
        map(() => this.applied('retry')),
        catchError((error: unknown) => {
          // Offline, the row now waits and the next sync resends it, so its text must not go
          // back to the composer, where Send would post it a second time.
          // A waiting echo with no composer text (a notice) still waits; there is just nothing
          // to hold for a reload.
          const text = unsentText(event);
          const waiting =
            text === null
              ? isWaitingToSend(event)
              : request.threadRootId
                ? keepWhileWaiting(
                    this.drafts,
                    threadDraftKey(request.threadRootId),
                    event,
                    text,
                  )
                : keepWhileWaiting(
                    this.drafts,
                    conversationDraftKey(request.key),
                    event,
                    { body: text, content: event.getContent() },
                  );
          return of(
            waiting
              ? this.applied('retry')
              : this.requestRejected('retry', error),
          );
        }),
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
      // CANCELLED is what releases the waiting draft record and stops the reconnect resend.
      context.client.cancelPendingEvent(event);
      return of(this.applied('cancel'));
    });
  }

  /**
   * Debounced: scrolling past several messages sends one receipt, for the newest. A waiting
   * receipt belongs to the adapter, so unsubscribing does not cancel it.
   */
  acknowledge(
    request: ConversationMessageActionRequest,
  ): Observable<ConversationMessageOutcome> {
    if (this.receiptDebounceMs <= 0) return this.sendReceipt(request);
    return defer(() => {
      const key = [
        request.key.accountId,
        request.key.roomId,
        request.threadRootId ?? '',
      ].join('\n');
      for (const [other, pending] of this.pendingReceipts) {
        if (pending.request.key.roomId !== request.key.roomId) {
          this.flushReceipt(other);
        }
      }
      // A newer ack swaps the request but keeps the running timer, so a steady stream of acks
      // still sends once per debounce window.
      const waiting = this.pendingReceipts.get(key);
      if (waiting) {
        waiting.request = request;
        return waiting.outcome.pipe(take(1));
      }
      const outcome = new ReplaySubject<ConversationMessageOutcome>(1);
      this.pendingReceipts.set(key, {
        request,
        outcome,
        timer: setTimeout(() => this.flushReceipt(key), this.receiptDebounceMs),
      });
      return outcome.pipe(take(1));
    });
  }

  flushReceipts(): void {
    for (const key of [...this.pendingReceipts.keys()]) this.flushReceipt(key);
  }

  private flushReceipt(key: string): void {
    const pending = this.pendingReceipts.get(key);
    if (!pending) return;
    this.pendingReceipts.delete(key);
    clearTimeout(pending.timer);
    this.sendReceipt(pending.request).subscribe((result) => {
      pending.outcome.next(result);
      pending.outcome.complete();
    });
  }

  private sendReceipt(
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
