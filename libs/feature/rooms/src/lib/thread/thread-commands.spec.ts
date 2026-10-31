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

  it('keeps the edit open when the edit is refused, so the typed text can be retried', () => {
    const { commands, thread, show } = setup();
    thread.edit.mockReturnValueOnce(
      of<ConversationThreadOutcome>({
        kind: 'rejected',
        operation: 'edit',
        failure: 'request-failed',
        retryable: true,
      }),
    );
    commands.startEdit('$m1');

    commands.submit({ text: 'fixed', mentions: [] });

    expect(thread.edit).toHaveBeenCalledWith('$m1', 'fixed', []);
    expect(show).toHaveBeenCalledWith(
      'Could not edit the message.',
      expect.anything(),
    );
    expect(commands.editingId()).toBe('$m1');
  });

  it('ends the edit once it is applied', () => {
    const { commands, thread } = setup();
    commands.startEdit('$m1');

    commands.submit({ text: 'fixed', mentions: [] });

    expect(thread.edit).toHaveBeenCalledWith('$m1', 'fixed', []);
    expect(commands.editingId()).toBeNull();
  });
});
