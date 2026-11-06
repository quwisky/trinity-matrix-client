import { TestBed } from '@angular/core/testing';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import {
  ConversationComposeStub,
  ConversationMessagesStub,
} from '../testing/conversation-timeline.stub';
import {
  MESSAGE_LIST_COMMANDS,
  provideRoomMessageListCommands,
} from './message-list-commands';

function setup() {
  const compose = new ConversationComposeStub();
  const messages = new ConversationMessagesStub(compose);
  TestBed.configureTestingModule({
    providers: [
      { provide: ConversationRuntime, useValue: { compose, messages } },
      provideRoomMessageListCommands(),
    ],
  });
  return { compose, messages, commands: TestBed.inject(MESSAGE_LIST_COMMANDS) };
}

describe('room message list commands', () => {
  it('maps the compose intent to editing and replying ids', () => {
    const { compose, commands } = setup();
    expect(commands.editingId()).toBeNull();
    compose.beginEdit('$e', 'b');
    expect(commands.editingId()).toBe('$e');
    expect(commands.replyingToId()).toBeNull();
    compose.beginReply('$r');
    expect(commands.replyingToId()).toBe('$r');
  });

  it('cancels only the intent kind it names', () => {
    const { compose, commands } = setup();
    const cancel = vi.spyOn(compose, 'cancelIntent');
    compose.beginReply('$r');
    commands.cancelEdit();
    expect(cancel).not.toHaveBeenCalled();
    commands.cancelReply();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels an edit intent once, and leaves it to a reply cancel', () => {
    const { compose, commands } = setup();
    const cancel = vi.spyOn(compose, 'cancelIntent');
    compose.beginEdit('$e', 'b');
    commands.cancelReply();
    expect(cancel).not.toHaveBeenCalled();
    commands.cancelEdit();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('begins edit and reply through the runtime', () => {
    const { messages, commands } = setup();
    const edit = vi.spyOn(messages, 'beginEdit');
    const reply = vi.spyOn(messages, 'beginReply');
    commands.beginEdit('$e', 'b');
    commands.beginReply('$r');
    expect(edit).toHaveBeenCalledWith('$e', 'b');
    expect(reply).toHaveBeenCalledWith('$r');
  });

  it('mirrors the sending flag', () => {
    const { compose, commands } = setup();
    compose.setSending(true);
    expect(commands.sending()).toBe(true);
  });
});
