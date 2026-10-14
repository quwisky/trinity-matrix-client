import { InjectionToken, type Signal } from '@angular/core';

/**
 * Whether the person can see the open conversation, beyond window focus: false while App
 * lock covers the app, or before its state is known. Optional; without it only focus
 * decides. Provided by Application Runtime, so Conversations never depends on App lock.
 */
export interface ConversationAttention {
  readonly attentive: Signal<boolean>;
}

export const CONVERSATION_ATTENTION = new InjectionToken<ConversationAttention>(
  'CONVERSATION_ATTENTION',
);
