import { signal, type Provider } from '@angular/core';
import { vi } from 'vitest';
import {
  MESSAGE_LIST_COMMANDS,
  type MessageListCommands,
} from './message-list-commands';

/** Inert commands: nothing is being edited or replied to; overrides replace any member. */
export function provideTestMessageListCommands(
  overrides: Partial<MessageListCommands> = {},
): Provider {
  return {
    provide: MESSAGE_LIST_COMMANDS,
    useValue: {
      editingId: signal(null),
      replyingToId: signal(null),
      sending: signal(false),
      beginEdit: vi.fn(),
      beginReply: vi.fn(),
      cancelEdit: vi.fn(),
      cancelReply: vi.fn(),
      ...overrides,
    } satisfies MessageListCommands,
  };
}
