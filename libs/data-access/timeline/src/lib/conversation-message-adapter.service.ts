import { Injectable, InjectionToken, inject, untracked } from '@angular/core';
import { defer, map, of, tap, type Observable } from 'rxjs';
import {
  DraftStoreService,
  PrivacySettingsService,
} from '@trinity/platform-native';
import { type EngineResult, retryableFailure } from '@trinity/util/matrix';
import type {
  ConversationKey,
  ConversationMessageActionRequest,
  ConversationMessageAdapter,
  ConversationMessageOperation,
  ConversationMessageOutcome,
  ConversationMessagePolicy,
  ConversationReactionRequest,
} from './conversation-messages';
import { conversationDraftKey, threadDraftKey } from './conversation-draft-key';
import type { TimelineFocus, TimelineItemKey } from './timeline-engine';
import { TIMELINE_ENGINE } from './timeline-engine.token';
import { TimelineStores } from './timeline-store';

const LIVE = { kind: 'live' } as const;

type Failure = Extract<
  ConversationMessageOutcome,
  { kind: 'rejected' }
>['failure'];

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

/** The transaction id of the local echo a row shows as `~<roomId>:<transactionId>`, else null. */
function echoTransactionId(
  request: ConversationMessageActionRequest,
): string | null {
  const prefix = `~${request.key.roomId}:`;
  return request.messageId.startsWith(prefix)
    ? request.messageId.slice(prefix.length)
    : null;
}

function itemKey(request: ConversationMessageActionRequest): TimelineItemKey {
  const transactionId = echoTransactionId(request);
  return transactionId === null
    ? { eventId: request.messageId, transactionId: null }
    : { eventId: null, transactionId };
}

function threadOf(request: ConversationMessageActionRequest) {
  return { threadRootId: request.threadRootId ?? null };
}

function rejected(
  operation: ConversationMessageOperation,
  failure: Failure,
): ConversationMessageOutcome {
  return { kind: 'rejected', operation, failure, retryable: false };
}

function outcome(
  operation: ConversationMessageOperation,
  result: EngineResult<null>,
): ConversationMessageOutcome {
  if (result.ok) return { kind: 'applied', operation };
  switch (result.failure.code) {
    case 'not-signed-in':
    case 'account-not-live':
      return rejected(operation, 'conversation-unavailable');
    case 'message-unavailable':
      return rejected(operation, 'message-unavailable');
    case 'not-cancellable':
      return rejected(operation, 'event-not-retryable');
    default:
      return {
        kind: 'rejected',
        operation,
        failure: 'request-rejected',
        retryable: retryableFailure(result.failure),
      };
  }
}

@Injectable({ providedIn: 'root' })
class EngineConversationMessageAdapter implements ConversationMessageAdapter {
  private readonly engine = inject(TIMELINE_ENGINE);
  private readonly privacy = inject(PrivacySettingsService);
  private readonly drafts = inject(DraftStoreService);
  private readonly stores = inject(TimelineStores);
  private readonly policy = inject(CONVERSATION_MESSAGE_POLICY);

  toggleReaction(
    request: ConversationReactionRequest,
  ): Observable<ConversationMessageOutcome> {
    return defer(() => {
      const reaction = request.reaction.trim();
      if (!reaction) return of(rejected('reaction', 'invalid-reaction'));
      const { accountId, roomId } = request.key;
      return this.engine
        .toggleReaction(
          accountId,
          roomId,
          itemKey(request),
          reaction,
          threadOf(request),
        )
        .pipe(map((result) => outcome('reaction', result)));
    });
  }

  redact(
    request: ConversationMessageActionRequest,
  ): Observable<ConversationMessageOutcome> {
    return defer(() => {
      const senderId = this.senderOf(request);
      if (senderId === null) {
        return of(rejected('redaction', 'message-unavailable'));
      }
      const decision = this.policy.authorizeRedaction({
        key: request.key,
        messageId: request.messageId,
        senderId,
      });
      if (decision.kind === 'rejected') {
        return of(rejected('redaction', decision.failure));
      }
      const { accountId, roomId } = request.key;
      return this.engine
        .redact(accountId, roomId, itemKey(request), threadOf(request))
        .pipe(map((result) => outcome('redaction', result)));
    });
  }

  retry(
    request: ConversationMessageActionRequest,
  ): Observable<ConversationMessageOutcome> {
    return defer(() => {
      const transactionId = echoTransactionId(request);
      // A row with an event id has been sent.
      if (transactionId === null) {
        return of(rejected('retry', 'event-not-retryable'));
      }
      const { accountId, roomId } = request.key;
      return this.engine
        .retrySend(accountId, roomId, transactionId)
        .pipe(map((result) => outcome('retry', result)));
    });
  }

  /**
   * Only a waiting or failed echo, as the engine cancels any unsent one. A thread's caller
   * checks its own rows; the room's are read from its store, past the window it presents.
   */
  cancel(
    request: ConversationMessageActionRequest,
  ): Observable<ConversationMessageOutcome> {
    return defer(() => {
      const transactionId = echoTransactionId(request);
      if (transactionId === null) {
        return of(rejected('cancel', 'event-not-retryable'));
      }
      if (!request.threadRootId) {
        const failure = this.uncancellable(request.key, transactionId);
        if (failure) return of(rejected('cancel', failure));
      }
      const { accountId, roomId } = request.key;
      return this.engine.cancelSend(accountId, roomId, transactionId).pipe(
        // CANCELLED stops the reconnect resend; the text held for a reload goes with it.
        tap((result) => {
          if (!result.ok) return;
          this.drafts.releaseWaiting(
            request.threadRootId
              ? threadDraftKey(request.threadRootId)
              : conversationDraftKey(request.key),
            transactionId,
          );
        }),
        map((result) => outcome('cancel', result)),
      );
    });
  }

  /** The sender of the row the request names, from the items its conversation holds. */
  private senderOf(request: ConversationMessageActionRequest): string | null {
    const { eventId, transactionId } = itemKey(request);
    const focus: TimelineFocus = request.threadRootId
      ? { kind: 'thread', rootEventId: request.threadRootId }
      : LIVE;
    const { store, release } = this.stores.hold(request.key, focus);
    const item = untracked(store.items).find(
      (candidate) =>
        candidate.kind === 'event' &&
        (eventId === null
          ? candidate.transactionId === transactionId
          : candidate.eventId === eventId),
    );
    release();
    return item?.kind === 'event' ? item.sender : null;
  }

  private uncancellable(
    key: ConversationKey,
    transactionId: string,
  ): Failure | null {
    const { store, release } = this.stores.hold(key, LIVE);
    const item = untracked(store.items).find(
      (candidate) =>
        candidate.kind === 'event' && candidate.transactionId === transactionId,
    );
    release();
    if (item?.kind !== 'event') return 'message-unavailable';
    const state = item.sendState?.kind;
    return state === 'waiting' || state === 'failed'
      ? null
      : 'event-not-retryable';
  }

  acknowledge(
    request: ConversationMessageActionRequest,
  ): Observable<ConversationMessageOutcome> {
    return defer(() => {
      const { accountId, roomId } = request.key;
      const threadRootId = request.threadRootId ?? null;
      return this.engine
        .sendReceipt(accountId, roomId, request.messageId, {
          threadRootId,
          visibility: this.privacy.sendReadReceipts() ? 'public' : 'private',
          // A thread has no read marker of its own.
          fullyRead: threadRootId === null,
        })
        .pipe(map((result) => outcome('receipt', result)));
    });
  }
}

export const CONVERSATION_MESSAGE_ADAPTER =
  new InjectionToken<ConversationMessageAdapter>(
    'conversation-runtime.message-adapter',
    {
      providedIn: 'root',
      factory: () => inject(EngineConversationMessageAdapter),
    },
  );
