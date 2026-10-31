import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { EMPTY, Subject, of, throwError, type Observable } from 'rxjs';
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
    edit: vi.fn((): Observable<ConversationThreadOutcome> => applied),
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
        failure: 'request-rejected',
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
    expect(commands.sending()).toBe(false);
  });

  it('ends the edit once it is applied', () => {
    const { commands, thread } = setup();
    commands.startEdit('$m1');

    commands.submit({ text: 'fixed', mentions: [] });

    expect(thread.edit).toHaveBeenCalledWith('$m1', 'fixed', []);
    expect(commands.editingId()).toBeNull();
    expect(commands.sending()).toBe(false);
  });

  it('stops sending when the edit errors, toasting and keeping the edit open', () => {
    const { commands, thread, show } = setup();
    thread.edit.mockReturnValueOnce(throwError(() => new Error('boom')));
    commands.startEdit('$m1');

    commands.submit({ text: 'fixed', mentions: [] });

    expect(show).toHaveBeenCalledTimes(1);
    expect(commands.editingId()).toBe('$m1');
    expect(commands.sending()).toBe(false);
  });

  it('stops sending when the edit completes without an outcome', () => {
    const { commands, thread } = setup();
    thread.edit.mockReturnValueOnce(EMPTY);
    commands.startEdit('$m1');

    commands.submit({ text: 'fixed', mentions: [] });

    expect(commands.editingId()).toBe('$m1');
    expect(commands.sending()).toBe(false);
  });

  it('does not start sending when no thread is open', () => {
    const { commands, thread } = setup();
    commands.thread.set(null);
    commands.startEdit('$m1');

    commands.submit({ text: 'fixed', mentions: [] });

    expect(thread.edit).not.toHaveBeenCalled();
    expect(commands.sending()).toBe(false);
  });

  describe('while an edit is pending', () => {
    const outcome = (kind: 'applied' | 'rejected') =>
      kind === 'applied'
        ? ({ kind, operation: 'edit' } as const)
        : ({
            kind,
            operation: 'edit',
            failure: 'request-rejected',
            retryable: true,
          } as const);

    function pending() {
      const ctx = setup();
      const reply = new Subject<ConversationThreadOutcome>();
      ctx.thread.edit.mockReturnValueOnce(reply);
      ctx.commands.startEdit('$m1');
      ctx.commands.submit({ text: 'one', mentions: [] });
      return { ...ctx, reply };
    }

    it('refuses a second submit, so only one edit is sent', () => {
      const { commands, thread } = pending();

      expect(commands.sending()).toBe(true);
      commands.submit({ text: 'two', mentions: [] });

      expect(thread.edit).toHaveBeenCalledTimes(1);
      expect(thread.send).not.toHaveBeenCalled();
    });

    it('is not closed by the old success after a cancel and re-edit of the same message', () => {
      const { commands, reply } = pending();

      commands.cancelEdit();
      commands.startEdit('$m1');
      reply.next(outcome('applied'));
      reply.complete();

      expect(commands.editingId()).toBe('$m1');
      expect(commands.sending()).toBe(false);
    });

    it('does not let a stale outcome stop a newer edit from sending', () => {
      const { commands, thread, reply } = pending();
      const newer = new Subject<ConversationThreadOutcome>();
      thread.edit.mockReturnValueOnce(newer);

      commands.cancelEdit();
      commands.startEdit('$m2');
      commands.submit({ text: 'two', mentions: [] });
      reply.next(outcome('rejected'));
      reply.complete();

      expect(commands.sending()).toBe(true);
    });

    it('only toasts on a later refusal, keeping the edit open and unblocked', () => {
      const { commands, reply, show } = pending();

      reply.next(outcome('rejected'));
      reply.complete();

      expect(show).toHaveBeenCalledTimes(1);
      expect(commands.editingId()).toBe('$m1');
      expect(commands.sending()).toBe(false);
    });

    it('closes the edit on success and accepts the next submit', () => {
      const { commands, thread, reply } = pending();

      reply.next(outcome('applied'));
      reply.complete();
      commands.submit({ text: 'plain', mentions: [] });

      expect(commands.editingId()).toBeNull();
      expect(thread.send).toHaveBeenCalledWith('plain', []);
    });

    it.each([
      ['reset', (c: ThreadCommands) => c.reset()],
      ['startReply', (c: ThreadCommands) => c.startReply('$m2')],
      ['editLastOwn', (c: ThreadCommands) => c.editLastOwn()],
    ])('%s stops the old outcome closing the edit state', (_name, act) => {
      const { commands, thread, reply } = pending();
      Object.assign(thread, {
        messages: () => [
          { id: '$m3', isOwn: true, status: null, kind: 'text' },
        ],
      });

      act(commands);
      const after = commands.editingId();
      reply.next(outcome('applied'));
      reply.complete();

      expect(commands.sending()).toBe(false);
      expect(commands.editingId()).toBe(after);
    });
  });
});
