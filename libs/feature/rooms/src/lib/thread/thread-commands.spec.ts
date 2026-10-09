import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  TimelineActionsService,
  type ConversationThread,
  type ConversationThreadOutcome,
} from '@trinity/data-access/timeline';
import { ThreadCommands } from './thread-commands';

const applied = of<ConversationThreadOutcome>({
  kind: 'applied',
  operation: 'send',
});

function setup() {
  const thread = {
    send: vi.fn(() => applied),
    edit: vi.fn(() => applied),
    reply: vi.fn(() => applied),
    media: { send: vi.fn() },
  };
  const show = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      ThreadCommands,
      MockProvider(TimelineActionsService),
      MockProvider(TrnAlertService),
      MockProvider(TrnToastService, { show }),
    ],
  });
  const commands = TestBed.inject(ThreadCommands);
  commands.thread.set(thread as unknown as ConversationThread);
  return { commands, thread, show };
}

describe('ThreadCommands', () => {
  it('does nothing without an open thread', () => {
    const { commands, thread } = setup();
    commands.thread.set(null);

    commands.submit({ text: 'a', mentions: [] });

    expect(thread.send).not.toHaveBeenCalled();
  });
});
