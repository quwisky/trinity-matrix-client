import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ImagePackEditorService } from '@trinity/data-access/media';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionError,
  EventStatus,
  MatrixError,
  RoomEvent,
  type IEvent,
  type MatrixEvent,
} from 'matrix-js-sdk';
import { DraftStoreService } from '@trinity/platform-native';
import {
  editMessageContent,
  renderMarkdown,
  slashCommandContent,
  textMessageContent,
} from '@trinity/util/matrix';
import { CONVERSATION_TEXT_SENDER } from './conversation-text-sender.service';
import { TIMELINE_ENGINE } from './timeline-engine.token';
import { TimelineStores } from './timeline-store';
import { conversationDraftKey } from './conversation-draft-key';
import { resolvedShields } from './js-sdk/shields';
import {
  ME,
  ROOM,
  sendingWorld,
  tick,
  type FakeEvent,
} from './js-sdk/js-sdk-timeline-engine.spec-harness';
import {
  fakeEdit,
  fakeEvent,
  matrixProvider,
  mediaProvider,
} from './timeline.spec-harness';

const KEY = { accountId: ME, roomId: ROOM } as const;

/** What the server does with each send: `pending` never answers, `no-echo` skips the echo. */
type Server = 'sent' | 'offline' | 'refused' | 'pending' | 'no-echo';

/** The statuses `cancelPendingEvent` accepts in the SDK. */
const CANCELLABLE = new Set([
  EventStatus.QUEUED,
  EventStatus.ENCRYPTING,
  EventStatus.NOT_SENT,
]);

function setup({
  server = 'sent',
  originalEdit,
}: {
  server?: Server;
  /** An encrypted edit of the original, saying `edited text`. */
  originalEdit?: ReturnType<typeof fakeEdit>;
} = {}) {
  const original = fakeEvent({
    id: '$original',
    sender: ME,
    body: 'original text',
    encrypted: originalEdit !== undefined,
    replacement: originalEdit && {
      ...originalEdit,
      getOriginalContent: () => ({
        'm.new_content': { msgtype: 'm.text', body: 'edited text' },
      }),
    },
  }) as FakeEvent;
  const w = sendingWorld([original]);
  const send = w.client.sendMessage.getMockImplementation()!;
  w.client.sendMessage.mockImplementation((...args: unknown[]) => {
    if (server === 'no-echo') return Promise.resolve({ event_id: '$event' });
    const reply = send(...args);
    const index = w.sends.length - 1;
    queueMicrotask(() => {
      if (server === 'sent') w.confirm(index, `$event${index || ''}`);
      if (server === 'offline') w.fail(index, new ConnectionError('offline'));
      if (server === 'refused') {
        w.fail(index, new MatrixError({ errcode: 'M_FORBIDDEN' }, 403));
      }
    });
    return reply;
  });
  w.client.cancelPendingEvent.mockImplementation((echo: MatrixEvent) => {
    if (!CANCELLABLE.has(echo.status as EventStatus)) {
      throw new Error('already sending');
    }
    const events = w.room.getLiveTimeline().getEvents();
    events.splice(events.indexOf(echo as unknown as FakeEvent), 1);
    w.update(echo, EventStatus.CANCELLED);
  });
  Object.assign(w.client, { getCrypto: () => undefined });
  w.client.fetchRoomEvent.mockImplementation(
    (roomId: string, eventId: string) =>
      Promise.resolve({
        event_id: eventId,
        room_id: roomId,
        type: 'm.room.message',
        sender: '@bob:example.org',
        origin_server_ts: 1,
        content: { msgtype: 'm.text', body: 'trimmed text' },
      } satisfies Partial<IEvent>),
  );
  const drafts = { holdWaiting: vi.fn(), releaseWaiting: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      matrixProvider(w.client),
      mediaProvider(),
      { provide: DraftStoreService, useValue: drafts },
      {
        provide: ImagePackEditorService,
        useValue: {
          emoticons: signal(new Map([['wave', 'mxc://hs/wave']])),
        },
      },
    ],
  });
  /** The content of send `index`, as the SDK received it. */
  const sent = (index: number) =>
    w.client.sendMessage.mock.calls[index][2] as Record<string, unknown>;
  return {
    sender: TestBed.inject(CONVERSATION_TEXT_SENDER),
    w,
    client: w.client,
    original,
    drafts,
    sent,
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('MatrixConversationTextSender', () => {
  it('is cold and accepts only the SDK-authoritative local echo', async () => {
    const { sender, client } = setup();
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
  });

  it('maps an expected SDK rejection to a safe retryable outcome', async () => {
    const { sender } = setup({ server: 'refused' });

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
    const { sender, drafts, w } = setup({ server: 'offline' });

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

    // Reconnected: the resend lands and the text is let go.
    w.update(w.sends[0].echo, EventStatus.SENDING);
    await tick();
    expect(drafts.releaseWaiting).not.toHaveBeenCalled();
    w.confirm(0, '$event');
    await tick();
    expect(drafts.releaseWaiting).toHaveBeenCalledWith(
      conversationDraftKey(KEY),
      'txn-1',
    );
  });

  it('an edit that fails offline stays a manual retry, holding nothing', async () => {
    // An edit never resends by itself (`isWaitingToSend`), as before the engine.
    const { sender, drafts } = setup({ server: 'offline' });

    await expect(
      firstValueFrom(
        sender.send({
          key: KEY,
          body: 'edited',
          mentions: [],
          intent: { kind: 'edit', eventId: '$original' },
        }).outcome,
      ),
    ).resolves.toEqual({ kind: 'rejected', retryable: true });
    expect(drafts.holdWaiting).not.toHaveBeenCalled();
  });

  it('a send in an open conversation opens no extra feed', async () => {
    const { sender } = setup();
    TestBed.inject(TimelineStores).open(KEY, { kind: 'live' });
    const timeline = vi.spyOn(TestBed.inject(TIMELINE_ENGINE), 'timeline');

    await firstValueFrom(
      sender.send({
        key: KEY,
        body: 'hello',
        mentions: [],
        intent: { kind: 'message' },
      }).outcome,
    );

    expect(timeline).not.toHaveBeenCalled();
  });

  it('queued sends share one feed, which ends once they are sent', async () => {
    const { sender, w } = setup({ server: 'offline' });
    const timeline = vi.spyOn(TestBed.inject(TIMELINE_ENGINE), 'timeline');
    const queue = (body: string) =>
      firstValueFrom(
        sender.send({
          key: KEY,
          body,
          mentions: [],
          intent: { kind: 'message' },
        }).outcome,
      );

    await expect(queue('one')).resolves.toEqual({ kind: 'queued' });
    await expect(queue('two')).resolves.toEqual({ kind: 'queued' });
    expect(timeline).toHaveBeenCalledOnce();
    expect(w.room.listenerCount(RoomEvent.Timeline)).toBeGreaterThan(0);

    w.confirm(0, '$one');
    w.confirm(1, '$two');
    await tick();
    expect(w.room.listenerCount(RoomEvent.Timeline)).toBe(0);
  });

  it('still rejects a send the server refused, keeping nothing aside', async () => {
    const { sender, drafts } = setup({ server: 'refused' });

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
    const { sender, client } = setup();

    await expect(
      firstValueFrom(
        sender.send({
          key: { accountId: '@bob:hs', roomId: ROOM },
          body: 'hello',
          mentions: [],
          intent: { kind: 'message' },
        }).outcome,
      ),
    ).resolves.toEqual({ kind: 'rejected', retryable: false });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('builds formatted text, mentions and slash commands inside the Conversation adapter', async () => {
    const { sender, sent } = setup();

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

    const formatted = sent(0);
    expect(formatted['m.mentions']).toEqual({ user_ids: ['@bob:hs'] });
    expect(formatted['formatted_body']).toContain('<strong>');
    expect(formatted['formatted_body']).toContain(
      'https://matrix.to/#/@bob:hs',
    );
    expect(sent(1)).toMatchObject({
      msgtype: 'm.emote',
      body: 'waves',
    });
  });

  it('builds reply and edit relations from Conversation-owned targets', async () => {
    const { sender, sent } = setup();

    await firstValueFrom(
      sender.send({
        key: KEY,
        body: 'reply text',
        mentions: [],
        intent: { kind: 'reply', eventId: '$original' },
      }).outcome,
    );
    // An edit's own event id is the engine's business; the row is the original's.
    await expect(
      firstValueFrom(
        sender.send({
          key: KEY,
          body: 'edited **text**',
          mentions: [],
          intent: { kind: 'edit', eventId: '$original' },
        }).outcome,
      ),
    ).resolves.toEqual({ kind: 'accepted', eventId: null });

    const reply = sent(0);
    expect(reply['m.relates_to']).toEqual({
      'm.in_reply_to': { event_id: '$original' },
    });
    expect(reply['formatted_body']).toContain('<mx-reply>');

    const edit = sent(1);
    expect(edit['m.relates_to']).toEqual({
      rel_type: 'm.replace',
      event_id: '$original',
    });
    expect(edit['m.new_content']).toMatchObject({ body: 'edited **text**' });
  });

  it('sends the content the message builders make', async () => {
    const { sender, sent } = setup();
    const emoticons = new Map([['wave', 'mxc://hs/wave']]);
    const render = (text: string) => renderMarkdown(text, emoticons);
    const mentions = [{ userId: '@bob:hs', display: '@Bob' }];
    const bodies = [
      'plain @Bob @room',
      '**rich** @Bob',
      '/shrug fine @room',
      '/plain *as is*',
      '/spoiler hidden',
      '/me waves at @Bob',
    ];

    for (const body of bodies) {
      await firstValueFrom(
        sender.send({ key: KEY, body, mentions, intent: { kind: 'message' } })
          .outcome,
      );
    }
    for (const body of ['plain', '**rich** @Bob @room']) {
      await firstValueFrom(
        sender.send({
          key: KEY,
          body,
          mentions,
          intent: { kind: 'edit', eventId: '$original' },
        }).outcome,
      );
    }

    bodies.forEach((body, i) =>
      expect(sent(i)).toEqual(
        slashCommandContent(body, render, mentions) ??
          textMessageContent(body, render(body), mentions),
      ),
    );
    expect(sent(6)).toEqual(
      editMessageContent('$original', 'plain', render('plain'), mentions),
    );
    expect(sent(7)).toEqual(
      editMessageContent(
        '$original',
        '**rich** @Bob @room',
        render('**rich** @Bob @room'),
        mentions,
      ),
    );
  });

  it('sending :code: from the composer sends the inline image', async () => {
    const { sender, sent } = setup();
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

    const [message, edit, reply] = [sent(0), sent(1), sent(2)];
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
      return (client.sendMessage.mock.lastCall?.[2] as Record<string, unknown>)[
        'body'
      ];
    };

    expect(await quote()).toContain(`> <${ME}> original text`);

    resolvedShields.set(original.replacingEvent() as never, null);
    expect(await quote()).toContain(`> <${ME}> edited text`);
  });

  it('fetches a reply target the room no longer holds before quoting it', async () => {
    const { sender, client, sent } = setup();

    await firstValueFrom(
      sender.send({
        key: KEY,
        body: 'reply text',
        mentions: [],
        intent: { kind: 'reply', eventId: '$trimmed' },
      }).outcome,
    );

    expect(client.fetchRoomEvent).toHaveBeenCalledWith(KEY.roomId, '$trimmed');
    const reply = sent(0);
    expect(reply['body']).toBe(
      '> <@bob:example.org> trimmed text\n\nreply text',
    );
    expect(reply['m.mentions']).toEqual({ user_ids: ['@bob:example.org'] });
    expect(reply['m.relates_to']).toEqual({
      'm.in_reply_to': { event_id: '$trimmed' },
    });
  });

  it('still sends a reply whose target cannot be fetched, without a quote', async () => {
    const { sender, client, sent } = setup();
    client.fetchRoomEvent.mockReturnValueOnce(
      Promise.reject(new Error('offline')),
    );

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

    const reply = sent(0);
    expect(reply['body']).toBe('reply text');
    expect(reply['m.relates_to']).toEqual({
      'm.in_reply_to': { event_id: '$trimmed' },
    });
  });

  it('reports a reply cancelled while its target is fetched as indeterminate, dropping the fetch', async () => {
    const { sender, client } = setup();
    let resolveFetch!: (raw: Partial<IEvent>) => void;
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

    // No echo shown is no proof nothing went out, so the composer keeps its text cleared.
    const cancelled = firstValueFrom(operation.cancel());
    subscription.unsubscribe();
    await expect(cancelled).resolves.toBe(false);
    resolveFetch({
      event_id: '$trimmed',
      room_id: KEY.roomId,
      type: 'm.room.message',
      sender: '@bob:example.org',
      origin_server_ts: 1,
      content: { msgtype: 'm.text', body: 'trimmed text' },
    });
    await tick();

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it('uses the error channel when an accepted event has no authoritative local echo', async () => {
    const { sender } = setup({ server: 'no-echo' });

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

  it('cancels only a local echo the SDK still proves is pending', async () => {
    const { sender, client, w } = setup({ server: 'pending' });
    const operation = sender.send({
      key: KEY,
      body: 'hello',
      mentions: [],
      intent: { kind: 'message' },
    });
    const subscription = operation.outcome.subscribe();
    w.update(w.sends[0].echo, EventStatus.QUEUED);

    await expect(firstValueFrom(operation.cancel())).resolves.toBe(true);
    expect(client.cancelPendingEvent).toHaveBeenCalledOnce();
    subscription.unsubscribe();
  });

  it('reports cancellation as indeterminate once the SDK may be sending', async () => {
    const { sender } = setup({ server: 'pending' });
    const operation = sender.send({
      key: KEY,
      body: 'hello',
      mentions: [],
      intent: { kind: 'message' },
    });
    const subscription = operation.outcome.subscribe();

    await expect(firstValueFrom(operation.cancel())).resolves.toBe(false);
    subscription.unsubscribe();
  });
});
