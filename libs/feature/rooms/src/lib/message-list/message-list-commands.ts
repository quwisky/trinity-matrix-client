import {
  InjectionToken,
  computed,
  inject,
  type Provider,
  type Signal,
} from '@angular/core';
import { ConversationRuntime } from '@trinity/data-access/timeline';

/** The edit/reply state the message list reads and drives, supplied by whatever hosts it. */
export interface MessageListCommands {
  readonly editingId: Signal<string | null>;
  readonly replyingToId: Signal<string | null>;
  readonly sending: Signal<boolean>;
  beginEdit(id: string, body: string): void;
  beginReply(id: string): void;
  cancelEdit(): void;
  cancelReply(): void;
}

export const MESSAGE_LIST_COMMANDS = new InjectionToken<MessageListCommands>(
  'MESSAGE_LIST_COMMANDS',
);

export function roomMessageListCommands(): MessageListCommands {
  const runtime = inject(ConversationRuntime);
  const { compose, messages } = runtime;
  const idFor = (kind: 'edit' | 'reply') =>
    computed(() => {
      const intent = compose.intent();
      return intent.kind === kind ? intent.eventId : null;
    });
  const cancel = (kind: 'edit' | 'reply') => () => {
    if (compose.intent().kind === kind) compose.cancelIntent();
  };
  return {
    editingId: idFor('edit'),
    replyingToId: idFor('reply'),
    sending: compose.sending,
    beginEdit: (id, body) => void messages.beginEdit(id, body),
    beginReply: (id) => void messages.beginReply(id),
    cancelEdit: cancel('edit'),
    cancelReply: cancel('reply'),
  };
}

export function provideRoomMessageListCommands(): Provider {
  return {
    provide: MESSAGE_LIST_COMMANDS,
    useFactory: roomMessageListCommands,
  };
}
