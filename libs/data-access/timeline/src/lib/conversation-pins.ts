import type { Signal } from '@angular/core';
import type { Observable } from 'rxjs';
import type { MessageShield } from './message-presentation';

export interface PinnedMessageView {
  readonly id: string;
  /**
   * `loading` while an event outside the loaded timeline is fetched; `unavailable`
   * when the server will not return it; `failed` when fetching it failed; retried on the
   * next invalidation. All three carry empty sender and body.
   */
  readonly status: 'loaded' | 'loading' | 'unavailable' | 'failed';
  readonly sender: string;
  readonly senderName: string;
  readonly body: string;
  readonly ts: number;
  /** The unencrypted mark for the message's text, as its timeline row carries it. */
  readonly shield: MessageShield | null;
}

export type ConversationPinOperation = 'pin' | 'unpin';

export type ConversationPinOutcome =
  | { readonly kind: 'applied'; readonly operation: ConversationPinOperation }
  | {
      readonly kind: 'rejected';
      readonly operation: ConversationPinOperation;
      readonly failure:
        | 'conversation-unavailable'
        | 'message-unavailable'
        | 'not-allowed'
        | 'request-rejected';
      readonly retryable: boolean;
    };

export interface ConversationPins {
  readonly eventIds: Signal<readonly string[]>;
  readonly messages: Signal<readonly PinnedMessageView[]>;
  readonly canMutate: Signal<boolean>;
  isPinned(eventId: string): boolean;
  pin(eventId: string): Observable<ConversationPinOutcome>;
  unpin(eventId: string): Observable<ConversationPinOutcome>;
  /** Re-fetch pinned messages whose fetch failed (e.g. when the panel reopens). */
  retryFailed(): void;
}

export interface ConversationPinPolicyKey {
  readonly accountId: string;
  readonly roomId: string;
}

export type ConversationPinDecision =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'rejected';
      readonly failure: 'conversation-unavailable' | 'not-allowed';
    };

/** A message to pin or unpin; `senderId` is null for an unpin of a message the timeline lacks. */
export interface ConversationPinRequest {
  readonly key: ConversationPinPolicyKey;
  readonly messageId: string;
  readonly senderId: string | null;
}

/** Room Administration port consumed by Conversations; it contains no SDK types. */
export interface ConversationPinPolicy {
  canMutate(key: ConversationPinPolicyKey): boolean;
  /** The timeline has already found a message to pin; unpinning needs none. */
  authorize(
    request: ConversationPinRequest,
    operation: ConversationPinOperation,
  ): ConversationPinDecision;
}
