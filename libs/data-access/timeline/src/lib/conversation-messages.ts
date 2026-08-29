import type { Observable } from 'rxjs';

export interface ConversationKey {
  readonly accountId: string;
  readonly roomId: string;
}

export type ConversationMessageOperation =
  'reply' | 'edit' | 'reaction' | 'redaction' | 'retry' | 'receipt';

export type ConversationMessageFailure =
  | 'conversation-unavailable'
  | 'message-unavailable'
  | 'invalid-reaction'
  | 'not-allowed'
  | 'event-not-retryable'
  | 'request-rejected';

export type ConversationMessageOutcome =
  | {
      readonly kind: 'applied';
      readonly operation: ConversationMessageOperation;
    }
  | {
      readonly kind: 'rejected';
      readonly operation: ConversationMessageOperation;
      readonly failure: ConversationMessageFailure;
      readonly retryable: boolean;
    };

export interface ConversationMessages {
  beginReply(messageId: string): ConversationMessageOutcome;
  beginEdit(messageId: string, draft: string): ConversationMessageOutcome;
  toggleReaction(
    messageId: string,
    key: string,
  ): Observable<ConversationMessageOutcome>;
  redact(messageId: string): Observable<ConversationMessageOutcome>;
  retry(messageId: string): Observable<ConversationMessageOutcome>;
  acknowledge(messageId: string): Observable<ConversationMessageOutcome>;
}

export interface ConversationMessageActionRequest {
  readonly key: ConversationKey;
  readonly messageId: string;
}

export interface ConversationReactionRequest extends ConversationMessageActionRequest {
  readonly reaction: string;
}

export interface ConversationMessageAdapter {
  toggleReaction(
    request: ConversationReactionRequest,
  ): Observable<ConversationMessageOutcome>;
  redact(
    request: ConversationMessageActionRequest,
  ): Observable<ConversationMessageOutcome>;
  retry(
    request: ConversationMessageActionRequest,
  ): Observable<ConversationMessageOutcome>;
  acknowledge(
    request: ConversationMessageActionRequest,
  ): Observable<ConversationMessageOutcome>;
}

export type ConversationRedactionDecision =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'rejected';
      readonly failure:
        'conversation-unavailable' | 'message-unavailable' | 'not-allowed';
    };

/** Room Administration port consumed by Conversations; it contains no SDK types. */
export interface ConversationMessagePolicy {
  canRedactOthers(key: ConversationKey): boolean;
  authorizeRedaction(
    request: ConversationMessageActionRequest,
  ): ConversationRedactionDecision;
}
