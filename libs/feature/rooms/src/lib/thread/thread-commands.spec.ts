import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  TimelineActionsService,
  type ConversationThread,
  type ConversationThreadOutcome,
} from '@trinity/data-access/timeline';
import type { MediaTransferEvent } from '@trinity/data-access/media';
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
  it('sends, edits or replies depending on the active mode, then leaves the mode', () => {
    const { commands, thread } = setup();

    commands.submit({ text: 'a', mentions: [] });
    commands.startEdit('$1');
    commands.submit({ text: 'b', mentions: [] });
    commands.startReply('$2');
    commands.submit({ text: 'c', mentions: [] });

    expect(thread.send).toHaveBeenCalledWith('a', []);
    expect(thread.edit).toHaveBeenCalledWith('$1', 'b', []);
    expect(thread.reply).toHaveBeenCalledWith('$2', 'c', []);
    expect(commands.editingId()).toBeNull();
    expect(commands.replyingToId()).toBeNull();
  });

  it('toasts a rejected action', () => {
    const { commands, thread, show } = setup();
    thread.send.mockReturnValue(
      of({ kind: 'rejected' } as ConversationThreadOutcome),
    );

    commands.submit({ text: 'a', mentions: [] });

    expect(show).toHaveBeenCalledWith('Could not send the message.', {
      duration: 4000,
      variant: 'danger',
    });
  });

  it('reset clears the mode and orphans an upload in flight', () => {
    const { commands, thread } = setup();
    const stream = new Subject<MediaTransferEvent>();
    thread.media.send.mockReturnValue(stream);
    commands.startEdit('$1');
    commands.sendMedia({
      items: [
        {
          id: 'a',
          file: new File(['x'], 'a.png', { type: 'image/png' }),
          media: { id: 'a' } as never,
        },
      ],
      caption: '',
      onOutcomes: () => undefined,
    });
    expect(commands.uploadProgress()).not.toBeNull();

    commands.reset();
    stream.next({ kind: 'progress', phase: 'uploading', fraction: 0.5 });

    expect(commands.editingId()).toBeNull();
    expect(commands.uploadProgress()).toBeNull();
  });

  it('does nothing without an open thread', () => {
    const { commands, thread } = setup();
    commands.thread.set(null);

    commands.submit({ text: 'a', mentions: [] });

    expect(thread.send).not.toHaveBeenCalled();
  });
});
