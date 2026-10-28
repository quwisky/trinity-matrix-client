import { InjectionToken, signal, type Signal } from '@angular/core';

export interface ConversationTypist {
  readonly userId: string;
  readonly displayName: string;
}

/**
 * Who else is typing in a room, read from the room list so Conversations never depends on
 * Room library. Provided by Application Runtime; without it nobody is typing.
 */
export interface ConversationTypingPort {
  typing(
    accountId: string,
    roomId: string,
  ): Signal<readonly ConversationTypist[]>;
}

const NOBODY: readonly ConversationTypist[] = [];

export const CONVERSATION_TYPING = new InjectionToken<ConversationTypingPort>(
  'CONVERSATION_TYPING',
  {
    factory: () => ({ typing: () => signal(NOBODY).asReadonly() }),
  },
);
