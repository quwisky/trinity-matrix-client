import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ImagePackEditorService } from '@trinity/data-access/media';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionError,
  EventStatus,
  MatrixError,
  MatrixEvent,
  type IEvent,
} from 'matrix-js-sdk';
import { DraftStoreService } from '@trinity/platform-native';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { CONVERSATION_TEXT_SENDER } from './conversation-text-sender.service';
import { conversationDraftKey } from './conversation-draft-key';
import { resolvedShields } from './js-sdk/shields';
import { fakeEdit, fakeEvent, fakeRoom } from './timeline.spec-harness';

const KEY = {
  accountId: '@alice:example.org',
  roomId: '!r:hs',
} as const;

function setup({
  localEcho = true,
  rejected = false,
  failure,
  accountId = KEY.accountId,
  pending = false,
  cancelable = false,
  fetched = 'found',
  originalEdit,
}: {
  localEcho?: boolean;
  rejected?: boolean;
  /** The SDK marks the echo NOT_SENT with this error before rejecting the send. */
  failure?: Error;
  accountId?: string;
  pending?: boolean;
  cancelable?: boolean;
  /** What the server returns for an event the room no longer holds. */
  fetched?: 'found' | 'failed';
  /** An encrypted edit of the original, saying `edited text`. */
  originalEdit?: ReturnType<typeof fakeEdit>;
} = {}) {
  const original = fakeEvent({
    id: '$original',
    sender: '@alice:example.org',
    body: 'original text',
    encrypted: originalEdit !== undefined,
    replacement: originalEdit && {
      ...originalEdit,
      getOriginalContent: () => ({
        'm.new_content': { msgtype: 'm.text', body: 'edited text' },
      }),
    },
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
  const failedEcho = new MatrixEvent({
    type: 'm.room.message',
    content: { msgtype: 'm.text', body: 'hello' },
  });
  failedEcho.setTxnId('txn-1');
  const room = {
    ...sourceRoom,
    getEventForTxnId: vi.fn((txnId: string) =>
      failure && txnId === 'txn-1' ? failedEcho : undefined,
    ),
    findEventById: vi.fn((eventId: string) => {
      if (eventId === pendingEvent.getId()) return pendingEvent;
      return eventId === '$event' && !localEcho
        ? undefined
        : sourceRoom.findEventById(eventId);
    }),
  };
  const client = {
    getUserId: vi.fn(() => accountId),
    getRoom: vi.fn(() => room),
    makeTxnId: vi.fn(() => 'txn-1'),
    cancelPendingEvent: vi.fn(() => {
      if (!cancelable) throw new Error('already sending');
    }),
    fetchRoomEvent: vi.fn((roomId: string, eventId: string) =>
      fetched === 'failed'
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({
            event_id: eventId,
            room_id: roomId,
            type: 'm.room.message',
            sender: '@bob:example.org',
            origin_server_ts: 1,
            content: { msgtype: 'm.text', body: 'trimmed text' },
          }),
    ),
    getEventMapper: vi.fn(() => (raw: Partial<IEvent>) => new MatrixEvent(raw)),
    decryptEventIfNeeded: vi.fn(() => Promise.resolve()),
    sendMessage: vi.fn((_roomId: string, _content: unknown) =>
      pending
        ? new Promise<never>(() => undefined)
        : failure
          ? Promise.resolve().then(() => {
              failedEcho.error = failure as never;
              failedEcho.setStatus(EventStatus.NOT_SENT);
              throw failure;
            })
          : rejected
            ? Promise.reject(new Error('offline'))
            : Promise.resolve({ event_id: '$event' }),
    ),
  };
  const drafts = { holdWaiting: vi.fn(), releaseWaiting: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: DraftStoreService, useValue: drafts },
      {
        provide: MatrixClientService,
        useValue: { clientFor: () => client },
      },
      {
        provide: ImagePackEditorService,
        useValue: {
          emoticons: signal(new Map([['wave', 'mxc://hs/wave']])),
        },
      },
    ],
  });
  return {
    sender: TestBed.inject(CONVERSATION_TEXT_SENDER),
    client,
    room,
    original,
    drafts,
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

  it('queues a send that failed offline and keeps its text for after a reload', async () => {
    const { sender, drafts } = setup({
      failure: new ConnectionError('offline'),
    });

    await expect(
      firstValueFrom(
        sender.send({
          key: KEY,
          body: 'hello',
          mentions: [],
          intent: { kind: 'message' },
        }).outcome,
      ),
    ).resolves.toEqual({ kind: 'queued' });
    expect(drafts.holdWaiting).toHaveBeenCalledWith(
      conversationDraftKey(KEY),
      'txn-1',
      'hello',
    );
  });

  it('still rejects a send the server refused, keeping nothing aside', async () => {
    const { sender, drafts } = setup({
      failure: new MatrixError({ errcode: 'M_FORBIDDEN' }, 403),
    });

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
    expect(drafts.holdWaiting).not.toHaveBeenCalled();
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

  it('sending :code: from the composer sends the inline image', async () => {
    const { sender, client } = setup();
    const image =
      '<img data-mx-emoticon="" src="mxc://hs/wave" alt=":wave:" title=":wave:" height="32">';

    for (const intent of [
      { kind: 'message' },
      { kind: 'edit', eventId: '$original' },
      { kind: 'reply', eventId: '$original' },
    ] as const) {
      await firstValueFrom(
        sender.send({ key: KEY, body: 'hi :wave:', mentions: [], intent })
          .outcome,
      );
    }

    const [message, edit, reply] = client.sendMessage.mock.calls.map(
      (call) => call[1] as Record<string, unknown>,
    );
    expect(message).toMatchObject({
      body: 'hi :wave:',
      format: 'org.matrix.custom.html',
    });
    expect(message['formatted_body']).toContain(image);
    expect(edit['formatted_body']).toContain(image);
    expect(edit['m.new_content']).toMatchObject({
      body: 'hi :wave:',
      formatted_body: expect.stringContaining(image),
    });
    expect(reply['formatted_body']).toContain(image);
  });

  it("quotes a reply's target as its row shows it, holding an unchecked edit back", async () => {
    const { sender, client, original } = setup({
      originalEdit: fakeEdit('$original', true),
    });
    const quote = async () => {
      await firstValueFrom(
        sender.send({
          key: KEY,
          body: 'reply text',
          mentions: [],
          intent: { kind: 'reply', eventId: '$original' },
        }).outcome,
      );
      return (client.sendMessage.mock.lastCall?.[1] as Record<string, unknown>)[
        'body'
      ];
    };

    expect(await quote()).toContain('> <@alice:example.org> original text');

    resolvedShields.set(original.replacingEvent() as never, null);
    expect(await quote()).toContain('> <@alice:example.org> edited text');
  });

  it('fetches a reply target the room no longer holds before quoting it', async () => {
    const { sender, client } = setup();

    await firstValueFrom(
      sender.send({
        key: KEY,
        body: 'reply text',
        mentions: [],
        intent: { kind: 'reply', eventId: '$trimmed' },
      }).outcome,
    );

    expect(client.fetchRoomEvent).toHaveBeenCalledWith(KEY.roomId, '$trimmed');
    const reply = client.sendMessage.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(reply['body']).toBe(
      '> <@bob:example.org> trimmed text\n\nreply text',
    );
    expect(reply['m.mentions']).toEqual({ user_ids: ['@bob:example.org'] });
    expect(reply['m.relates_to']).toEqual({
      'm.in_reply_to': { event_id: '$trimmed' },
    });
  });

  it('still sends a reply whose target cannot be fetched, without a quote', async () => {
    const { sender, client } = setup({ fetched: 'failed' });

    await expect(
      firstValueFrom(
        sender.send({
          key: KEY,
          body: 'reply text',
          mentions: [],
          intent: { kind: 'reply', eventId: '$trimmed' },
        }).outcome,
      ),
    ).resolves.toEqual({ kind: 'accepted', eventId: '$event' });

    const reply = client.sendMessage.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(reply['body']).toBe('reply text');
    expect(reply['m.relates_to']).toEqual({
      'm.in_reply_to': { event_id: '$trimmed' },
    });
  });

  it('cancels a reply while its target is still being fetched and drops the late fetch', async () => {
    const { sender, client } = setup();
    let resolveFetch!: (
      raw: Awaited<ReturnType<typeof client.fetchRoomEvent>>,
    ) => void;
    client.fetchRoomEvent.mockReturnValueOnce(
      new Promise((resolve) => (resolveFetch = resolve)),
    );
    const operation = sender.send({
      key: KEY,
      body: 'reply text',
      mentions: [],
      intent: { kind: 'reply', eventId: '$trimmed' },
    });
    const outcomes: unknown[] = [];
    const subscription = operation.outcome.subscribe((outcome) =>
      outcomes.push(outcome),
    );

    expect(operation.cancel()).toBe(true);
    subscription.unsubscribe();
    resolveFetch({
      event_id: '$trimmed',
      room_id: KEY.roomId,
      type: 'm.room.message',
      sender: '@bob:example.org',
      origin_server_ts: 1,
      content: { msgtype: 'm.text', body: 'trimmed text' },
    });
    await new Promise((resolve) => setTimeout(resolve));

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
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
