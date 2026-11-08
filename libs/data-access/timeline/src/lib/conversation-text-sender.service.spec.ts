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
import { resolvedShields } from './shields';
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
  failedEcho.setStatus(EventStatus.SENDING);
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

  it('queues a send that failed offline and keeps it by txn id for after a reload', async () => {
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
    expect(drafts.holdWaiting).toHaveBeenLastCalledWith(
      conversationDraftKey(KEY),
      'txn-1',
      expect.objectContaining({
        body: 'hello',
        content: expect.objectContaining({ body: 'hello' }),
      }),
    );
    expect(drafts.releaseWaiting).not.toHaveBeenCalled();
  });

  it('reports a send the server refused as a failed message, keeping it by txn id', async () => {
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
    ).resolves.toEqual({ kind: 'failed' });
    expect(drafts.holdWaiting).toHaveBeenCalledWith(
      conversationDraftKey(KEY),
      'txn-1',
      expect.objectContaining({ body: 'hello' }),
    );
    expect(drafts.releaseWaiting).not.toHaveBeenCalled();
  });

  it('lets go of a send that left no echo, whose text goes back to the draft', async () => {
    const { sender, drafts } = setup({ rejected: true });

    await firstValueFrom(
      sender.send({
        key: KEY,
        body: 'hello',
        mentions: [],
        intent: { kind: 'message' },
      }).outcome,
    );

    expect(drafts.releaseWaiting).toHaveBeenCalledWith(
      conversationDraftKey(KEY),
      'txn-1',
    );
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

  it('applies a text-art command in a reply, keeping its markdown literal', async () => {
    const { sender, client } = setup();

    await firstValueFrom(
      sender.send({
        key: KEY,
        body: '/tableflip **enough**',
        mentions: [],
        intent: { kind: 'reply', eventId: '$original' },
      }).outcome,
    );

    const reply = client.sendMessage.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(reply['body']).toMatch(/\*\*enough\*\* \(╯°□°）╯︵ ┻━┻$/u);
    expect(reply['formatted_body']).toContain(
      '<strong>enough</strong> (╯°□°）╯︵ ┻━┻',
    );
    expect(reply['m.relates_to']).toEqual({
      'm.in_reply_to': { event_id: '$original' },
    });
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

describe('a sent message, kept by its txn id until the homeserver has it', () => {
  const BOB = '@bob:example.org';
  const MESSAGE = { mentions: [], intent: { kind: 'message' } } as const;

  /** Like the SDK: a send adds a SENDING echo at once and settles it later. */
  function sdkRoom(accountId: string) {
    const echoes = new Map<string, MatrixEvent>();
    const live: MatrixEvent[] = [];
    const settle = new Map<
      string,
      { sent(): void; fail(error: Error): void }
    >();
    let next = 0;
    const room = {
      roomId: KEY.roomId,
      getEventForTxnId: (txnId: string) => echoes.get(txnId),
      findEventById: (id: string) =>
        [...echoes.values(), ...live].find((event) => event.getId() === id),
      getLiveTimeline: () => ({ getEvents: () => live }),
      addPendingEvent: vi.fn((event: MatrixEvent, txnId: string) =>
        echoes.set(txnId, event),
      ),
    };
    const client = {
      getUserId: () => accountId,
      getRoom: () => room,
      makeTxnId: () => `txn-${++next}`,
      // A reply target the room does not hold stays loading.
      fetchRoomEvent: vi.fn(() => new Promise<never>(() => undefined)),
      sendMessage: vi.fn((roomId: string, content: object, txnId: string) => {
        const echo = new MatrixEvent({
          type: 'm.room.message',
          content: content as IEvent['content'],
          event_id: `~${roomId}:${txnId}`,
          sender: accountId,
          room_id: roomId,
        });
        echo.setTxnId(txnId);
        echo.setStatus(EventStatus.SENDING);
        echoes.set(txnId, echo);
        return new Promise((resolve, reject) =>
          settle.set(txnId, {
            sent: () => {
              echo.setStatus(EventStatus.SENT);
              resolve({ event_id: echo.getId() });
            },
            fail: (error) => {
              echo.error = error as never;
              echo.setStatus(EventStatus.NOT_SENT);
              reject(error);
            },
          }),
        );
      }),
    };
    return { room, client, live, echoes, settle };
  }

  async function setup(
    rooms: Record<string, ReturnType<typeof sdkRoom>>,
    drafts?: DraftStoreService,
  ) {
    TestBed.configureTestingModule({
      providers: [
        ...(drafts ? [{ provide: DraftStoreService, useValue: drafts }] : []),
        {
          provide: MatrixClientService,
          useValue: { clientFor: (id: string) => rooms[id]?.client },
        },
        {
          provide: ImagePackEditorService,
          useValue: { emoticons: signal(new Map()) },
        },
      ],
    });
    const store = TestBed.inject(DraftStoreService);
    if (!drafts) await store.init();
    return { sender: TestBed.inject(CONVERSATION_TEXT_SENDER), store };
  }

  /** The stored drafts as a reloaded page reads them, with the SDK's echoes gone. */
  async function reload(store: DraftStoreService) {
    await store.flush();
    TestBed.resetTestingModule();
    const reloaded = new DraftStoreService();
    await reloaded.init();
    const fresh = sdkRoom(KEY.accountId);
    return { fresh, ...(await setup({ [KEY.accountId]: fresh }, reloaded)) };
  }

  const held = (
    store: DraftStoreService,
    accountId: string = KEY.accountId,
  ) => [
    ...store
      .pendingMessages(conversationDraftKey({ ...KEY, accountId }))
      .keys(),
  ];

  afterEach(() => localStorage.clear());

  it('lets each of two sends go by its own id when they settle out of order', async () => {
    const sdk = sdkRoom(KEY.accountId);
    const { sender, store } = await setup({ [KEY.accountId]: sdk });
    const first = firstValueFrom(
      sender.send({ key: KEY, body: 'same', ...MESSAGE }).outcome,
    );
    const second = firstValueFrom(
      sender.send({ key: KEY, body: 'same', ...MESSAGE }).outcome,
    );
    expect(held(store)).toEqual(['txn-1', 'txn-2']);

    sdk.settle.get('txn-2')?.sent();
    await second;
    expect(held(store)).toEqual(['txn-1']);

    sdk.settle.get('txn-1')?.sent();
    await expect(first).resolves.toMatchObject({ kind: 'accepted' });
    expect(held(store)).toEqual([]);
  });

  it('shows a failed send again after a reload, ready to Retry under its txn id', async () => {
    const sdk = sdkRoom(KEY.accountId);
    const { sender, store } = await setup({ [KEY.accountId]: sdk });
    const outcome = firstValueFrom(
      sender.send({ key: KEY, body: 'hello **you**', ...MESSAGE }).outcome,
    );
    sdk.settle
      .get('txn-1')
      ?.fail(new MatrixError({ errcode: 'M_FORBIDDEN' }, 403));
    await expect(outcome).resolves.toEqual({ kind: 'failed' });
    const sentContent = sdk.client.sendMessage.mock.calls[0][1];

    const after = await reload(store);
    after.sender.restore?.(KEY);
    after.sender.restore?.(KEY); // a second handle for the room adds nothing

    expect(after.fresh.room.addPendingEvent).toHaveBeenCalledOnce();
    const [echo, txnId] = after.fresh.room.addPendingEvent.mock.calls[0];
    expect(txnId).toBe('txn-1');
    expect(echo.getTxnId()).toBe('txn-1');
    expect(echo.getId()).toBe(`~${KEY.roomId}:txn-1`);
    expect(echo.status).toBe(EventStatus.NOT_SENT);
    expect(echo.getContent()).toEqual(sentContent);
    expect(after.store.get(conversationDraftKey(KEY))).toBe('');

    // Retry resends that echo; once the homeserver has it, it is let go.
    echo.setStatus(EventStatus.SENDING);
    expect(held(after.store)).toEqual(['txn-1']);
    echo.setStatus(EventStatus.SENT);
    expect(held(after.store)).toEqual([]);
  });

  it('lets go of a held message the timeline already shows as sent', async () => {
    const sdk = sdkRoom(KEY.accountId);
    const { sender, store } = await setup({ [KEY.accountId]: sdk });
    void firstValueFrom(
      sender.send({ key: KEY, body: 'hello', ...MESSAGE }).outcome,
    );

    const after = await reload(store);
    after.fresh.live.push(
      new MatrixEvent({
        type: 'm.room.message',
        event_id: '$remote',
        content: { msgtype: 'm.text', body: 'hello' },
        unsigned: { transaction_id: 'txn-1' },
      }),
    );
    after.sender.restore?.(KEY);

    expect(after.fresh.room.addPendingEvent).not.toHaveBeenCalled();
    expect(held(after.store)).toEqual([]);
  });

  it('keeps one account’s failed message out of another account in the same room', async () => {
    const alice = sdkRoom(KEY.accountId);
    const bob = sdkRoom(BOB);
    const { sender, store } = await setup({
      [KEY.accountId]: alice,
      [BOB]: bob,
    });
    const outcome = firstValueFrom(
      sender.send({ key: KEY, body: 'alice only', ...MESSAGE }).outcome,
    );
    alice.settle
      .get('txn-1')
      ?.fail(new MatrixError({ errcode: 'M_FORBIDDEN' }, 403));
    await outcome;

    sender.restore?.({ accountId: BOB, roomId: KEY.roomId });

    expect(bob.room.addPendingEvent).not.toHaveBeenCalled();
    expect(held(store, BOB)).toEqual([]);
    expect(held(store)).toEqual(['txn-1']);
  });

  it('keeps the reply target and mentions from the moment it sends', async () => {
    const sdk = sdkRoom(KEY.accountId);
    const { sender, store } = await setup({ [KEY.accountId]: sdk });
    const mentions = [{ userId: '@bob:hs', display: '@Bob' }];

    void firstValueFrom(
      sender.send({
        key: KEY,
        body: 'reply @Bob',
        mentions,
        intent: { kind: 'reply', eventId: '$target' },
      }).outcome,
    );

    expect(
      store.pendingMessages(conversationDraftKey(KEY)).get('txn-1'),
    ).toMatchObject({ body: 'reply @Bob', replyTo: '$target', mentions });
  });

  it('rebuilds a reply held before it was built as a reply, with its mentions', async () => {
    const sdk = sdkRoom(KEY.accountId);
    const { sender, store } = await setup({ [KEY.accountId]: sdk });
    store.holdWaiting(conversationDraftKey(KEY), 'txn-9', {
      body: 'reply @Bob',
      replyTo: '$target',
      mentions: [{ userId: '@bob:hs', display: '@Bob' }],
    });

    sender.restore?.(KEY);

    const [echo] = sdk.room.addPendingEvent.mock.calls[0];
    expect(echo.getContent()['m.relates_to']).toEqual({
      'm.in_reply_to': { event_id: '$target' },
    });
    expect(echo.getContent()['m.mentions']).toEqual({
      user_ids: ['@bob:hs'],
    });
  });

  it('shows a held message once its room arrives, after a restore that found no room', async () => {
    const sdk = sdkRoom(KEY.accountId);
    const { sender, store } = await setup({ [KEY.accountId]: sdk });
    store.holdWaiting(conversationDraftKey(KEY), 'txn-9', { body: 'kept' });
    const getRoom = vi.spyOn(sdk.client, 'getRoom');
    getRoom.mockReturnValueOnce(null as never);

    sender.restore?.(KEY);
    expect(sdk.room.addPendingEvent).not.toHaveBeenCalled();
    sender.restore?.(KEY);

    expect(sdk.room.addPendingEvent).toHaveBeenCalledOnce();
  });

  it('shows no failed copy of a reply still waiting for its target to load', async () => {
    const sdk = sdkRoom(KEY.accountId);
    const { sender } = await setup({ [KEY.accountId]: sdk });
    const sending = sender
      .send({
        key: KEY,
        body: 'reply text',
        mentions: [],
        intent: { kind: 'reply', eventId: '$not-loaded' },
      })
      .outcome.subscribe();

    sender.restore?.(KEY);

    expect(sdk.room.addPendingEvent).not.toHaveBeenCalled();
    sending.unsubscribe();
  });
});
