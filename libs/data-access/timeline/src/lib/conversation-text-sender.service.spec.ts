import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationActionContextService } from './conversation-action-context.service';
import { CONVERSATION_TEXT_SENDER } from './conversation-text-sender.service';
import { fakeEvent, fakeRoom } from './timeline.spec-harness';

const KEY = {
  accountId: '@alice:example.org',
  roomId: '!r:hs',
} as const;

function setup({
  localEcho = true,
  rejected = false,
  accountId = KEY.accountId,
  pending = false,
  cancelable = false,
}: {
  localEcho?: boolean;
  rejected?: boolean;
  accountId?: string;
  pending?: boolean;
  cancelable?: boolean;
} = {}) {
  const original = fakeEvent({
    id: '$original',
    sender: '@alice:example.org',
    body: 'original text',
  });
  const event = fakeEvent({
    id: '$event',
    sender: '@alice:example.org',
    body: 'sent text',
  });
  const pendingEvent = fakeEvent({
    id: '~!r:hs:txn-1',
    sender: '@alice:example.org',
    body: 'pending text',
  });
  const sourceRoom = fakeRoom([original, event]);
  const room = {
    ...sourceRoom,
    findEventById: vi.fn((eventId: string) => {
      if (eventId === pendingEvent.getId()) return pendingEvent;
      return eventId === '$event' && !localEcho
        ? undefined
        : sourceRoom.findEventById(eventId);
    }),
  };
  const client = {
    getUserId: vi.fn(() => accountId),
    makeTxnId: vi.fn(() => 'txn-1'),
    cancelPendingEvent: vi.fn(() => {
      if (!cancelable) throw new Error('already sending');
    }),
    sendMessage: vi.fn((_roomId: string, _content: unknown) =>
      pending
        ? new Promise<never>(() => undefined)
        : rejected
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({ event_id: '$event' }),
    ),
  };
  TestBed.configureTestingModule({
    providers: [ConversationActionContextService],
  });
  const context = TestBed.inject(ConversationActionContextService);
  context.bind(() => ({ client, room }) as never);
  return {
    sender: TestBed.inject(CONVERSATION_TEXT_SENDER),
    client,
    room,
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('MatrixConversationTextSender', () => {
  it('is cold and accepts only the SDK-authoritative local echo', async () => {
    const { sender, client, room } = setup();
    const command = sender.send({
      key: KEY,
      body: 'hello',
      mentions: [],
      intent: { kind: 'message' },
    });

    expect(client.sendMessage).not.toHaveBeenCalled();
    await expect(firstValueFrom(command.outcome)).resolves.toEqual({
      kind: 'accepted',
      eventId: '$event',
    });
    expect(room.findEventById).toHaveBeenCalledWith('$event');
  });

  it('maps an expected SDK rejection to a safe retryable outcome', async () => {
    const { sender } = setup({ rejected: true });

    await expect(
      firstValueFrom(
        sender.send({
          key: KEY,
          body: 'hello',
          mentions: [],
          intent: { kind: 'message' },
        }).outcome,
      ),
    ).resolves.toEqual({ kind: 'rejected', retryable: true });
  });

  it('rejects an action context for a different Account even when the Room id matches', async () => {
    const { sender, client } = setup({ accountId: '@bob:example.org' });

    await expect(
      firstValueFrom(
        sender.send({
          key: KEY,
          body: 'hello',
          mentions: [],
          intent: { kind: 'message' },
        }).outcome,
      ),
    ).resolves.toEqual({ kind: 'rejected', retryable: false });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('builds formatted text, mentions and slash commands inside the Conversation adapter', async () => {
    const { sender, client } = setup();

    await firstValueFrom(
      sender.send({
        key: KEY,
        body: 'hi **@Bob**',
        mentions: [{ userId: '@bob:hs', display: '@Bob' }],
        intent: { kind: 'message' },
      }).outcome,
    );
    await firstValueFrom(
      sender.send({
        key: KEY,
        body: '/me waves',
        mentions: [],
        intent: { kind: 'message' },
      }).outcome,
    );

    const formatted = client.sendMessage.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(formatted['m.mentions']).toEqual({ user_ids: ['@bob:hs'] });
    expect(formatted['formatted_body']).toContain('<strong>');
    expect(formatted['formatted_body']).toContain(
      'https://matrix.to/#/@bob:hs',
    );
    expect(client.sendMessage.mock.calls[1][1]).toMatchObject({
      msgtype: 'm.emote',
      body: 'waves',
    });
  });

  it('builds reply and edit relations from Conversation-owned targets', async () => {
    const { sender, client } = setup();

    await firstValueFrom(
      sender.send({
        key: KEY,
        body: 'reply text',
        mentions: [],
        intent: { kind: 'reply', eventId: '$original' },
      }).outcome,
    );
    await firstValueFrom(
      sender.send({
        key: KEY,
        body: 'edited **text**',
        mentions: [],
        intent: { kind: 'edit', eventId: '$original' },
      }).outcome,
    );

    const reply = client.sendMessage.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(reply['m.relates_to']).toEqual({
      'm.in_reply_to': { event_id: '$original' },
    });
    expect(reply['formatted_body']).toContain('<mx-reply>');

    const edit = client.sendMessage.mock.calls[1][1] as Record<string, unknown>;
    expect(edit['m.relates_to']).toEqual({
      rel_type: 'm.replace',
      event_id: '$original',
    });
    expect(edit['m.new_content']).toMatchObject({ body: 'edited **text**' });
  });

  it('uses the error channel when an accepted event has no authoritative local echo', async () => {
    const { sender } = setup({ localEcho: false });

    await expect(
      firstValueFrom(
        sender.send({
          key: KEY,
          body: 'hello',
          mentions: [],
          intent: { kind: 'message' },
        }).outcome,
      ),
    ).rejects.toThrow('without exposing its local echo');
  });

  it('cancels only a local echo the SDK still proves is pending', () => {
    const { sender, client } = setup({ pending: true, cancelable: true });
    const operation = sender.send({
      key: KEY,
      body: 'hello',
      mentions: [],
      intent: { kind: 'message' },
    });
    const subscription = operation.outcome.subscribe();

    expect(operation.cancel()).toBe(true);
    expect(client.cancelPendingEvent).toHaveBeenCalledOnce();
    subscription.unsubscribe();
  });

  it('reports cancellation as indeterminate once the SDK may be sending', () => {
    const { sender } = setup({ pending: true });
    const operation = sender.send({
      key: KEY,
      body: 'hello',
      mentions: [],
      intent: { kind: 'message' },
    });
    const subscription = operation.outcome.subscribe();

    expect(operation.cancel()).toBe(false);
    subscription.unsubscribe();
  });
});
