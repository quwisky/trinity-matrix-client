import { TestBed } from '@angular/core/testing';
import {
  ConnectionError,
  EventStatus,
  M_POLL_END,
  M_POLL_RESPONSE,
  M_POLL_START,
  MatrixError,
  MatrixEvent,
  RoomEvent,
  type IEvent,
} from 'matrix-js-sdk';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaService } from '@trinity/data-access/media';
import {
  locationMessageContent,
  pollEndContent,
  pollResponseContent,
  pollStartContent,
  voiceMessageContent,
  type EngineResult,
} from '@trinity/util/matrix';
import type { OutgoingMessage, OutgoingText } from '../timeline-engine';
import {
  ME,
  ROOM,
  engineFor,
  failureCode,
  msg,
  tick,
  watch,
  world,
  LIVE,
  type FakeEvent,
  type Options,
} from './js-sdk-timeline-engine.spec-harness';

/** Holds the end of a page, after it landed and before its flush, while `hold` is set. */
const pageEnd = vi.hoisted(() => ({ hold: null as Promise<void> | null }));
vi.mock('./live-scrollback', async (importOriginal) => {
  const real = await importOriginal<typeof import('./live-scrollback')>();
  return {
    ...real,
    scrollbackLive: async (...args: Parameters<typeof real.scrollbackLive>) => {
      await real.scrollbackLive(...args);
      if (pageEnd.hold) await pageEnd.hold;
    },
  };
});

const MAIN = { threadRootId: null, replyTo: null } as const;
const NO_THREAD = { threadRootId: null } as const;
const TARGET = '!t:hs';

const HELLO: OutgoingText = {
  msgtype: 'text',
  body: 'hello',
  formattedBody: null,
  mentions: { userIds: [], room: false },
};

function text(message: OutgoingText = HELLO): OutgoingMessage {
  return { kind: 'text', ...message };
}

interface Send {
  readonly echo: MatrixEvent;
  readonly args: readonly unknown[];
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** {@link world} with a client that adds a real local echo per send, as the SDK does. */
function sendingWorld(
  events: FakeEvent[] = [msg('$a')],
  options: Options = {},
) {
  const w = world(events, options);
  const { room, client } = w;
  const sends: Send[] = [];
  const echoes = new Map<string, MatrixEvent>();
  let txn = 0;
  const update = (echo: MatrixEvent, status: EventStatus | null) => {
    const oldId = echo.getId();
    echo.setStatus(status);
    room.emit(RoomEvent.LocalEchoUpdated, echo, room, oldId);
  };
  const send = (type: string, args: unknown[]) => {
    // The SDK's overloads: (roomId, [threadId,] [type,] content, txnId).
    const [, ...rest] = args;
    const content = rest.find(
      (arg) => typeof arg === 'object' && arg !== null,
    ) as Record<string, unknown>;
    const txnId = rest[rest.length - 1] as string;
    const echo = new MatrixEvent({
      type,
      content,
      sender: ME,
      room_id: args[0] as string,
      event_id: `~${ROOM}:${txnId}`,
      origin_server_ts: 1,
    });
    echo.setTxnId(txnId);
    echo.setStatus(EventStatus.SENDING);
    if (args[0] === ROOM) {
      echoes.set(txnId, echo);
      room
        .getLiveTimeline()
        .getEvents()
        .push(echo as unknown as FakeEvent);
      room.emit(RoomEvent.Timeline, echo, room, false, false);
    }
    return new Promise((resolve, reject) =>
      sends.push({ echo, args, resolve, reject }),
    );
  };
  Object.assign(room, {
    getEventForTxnId: (txnId: string) => echoes.get(txnId),
  });
  const sending = Object.assign(client, {
    makeTxnId: () => `txn-${++txn}`,
    sendMessage: vi.fn((...args: unknown[]) => send('m.room.message', args)),
    sendEvent: vi.fn((...args: unknown[]) =>
      send(
        args.find(
          (a, i) => i > 0 && typeof a === 'string' && !a.startsWith('$'),
        ) as string,
        args,
      ),
    ),
    redactEvent: vi.fn(() => Promise.resolve({ event_id: '$redaction' })),
    resendEvent: vi.fn((echo: MatrixEvent) => {
      update(echo, EventStatus.SENDING);
      return Promise.resolve({ event_id: '$resent' });
    }),
    cancelPendingEvent: vi.fn((echo: MatrixEvent) => {
      if (echo.status !== EventStatus.NOT_SENT) {
        throw new Error(`cannot cancel an event with status ${echo.status}`);
      }
      // As the SDK does, a cancelled echo leaves the timeline.
      const events = room.getLiveTimeline().getEvents();
      events.splice(events.indexOf(echo as unknown as FakeEvent), 1);
      update(echo, EventStatus.CANCELLED);
    }),
    getEventMapper: () => (raw: Partial<IEvent>) => new MatrixEvent(raw),
  });
  return {
    ...w,
    client: sending,
    sends,
    /** The server accepted send `index` as `eventId`. */
    confirm(index: number, eventId: string) {
      const { echo, resolve } = sends[index];
      echo.replaceLocalEventId(eventId);
      update(echo, EventStatus.SENT);
      resolve({ event_id: eventId });
    },
    /** Send `index` failed with `error`, leaving its echo unsent. */
    fail(index: number, error: Error) {
      const { echo, reject } = sends[index];
      echo.error = error as never;
      update(echo, EventStatus.NOT_SENT);
      reject(error);
    },
    update,
  };
}

function ok<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(result.failure.code);
  return result.value;
}

describe('JsSdkTimelineEngine sending', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('the echo is in timeline() before send replies', async () => {
    const w = sendingWorld();
    const engine = engineFor(w.client);
    const timeline = watch(engine);
    const echoAtReply = () =>
      timeline.events().find((item) => item.transactionId === 'txn-1');

    const reply = firstValueFrom(engine.send(ME, ROOM, text(), MAIN)).then(
      (result) => ({ result, item: echoAtReply() }),
    );

    // Shown at once, while the server has not answered yet.
    expect(echoAtReply()).toMatchObject({
      uniqueId: 'txn:txn-1',
      eventId: null,
      isOwn: true,
      sendState: { kind: 'sending' },
      content: { kind: 'message', body: 'hello' },
    });
    w.confirm(0, '$e');
    const { result, item } = await reply;
    expect(ok(result)).toEqual({ transactionId: 'txn-1', eventId: '$e' });
    expect(item).toMatchObject({ uniqueId: 'txn:txn-1', eventId: '$e' });
    timeline.subscription.unsubscribe();
  });

  it('a refused send replies with no event id once its failed echo shows', async () => {
    const w = sendingWorld();
    const engine = engineFor(w.client);
    const timeline = watch(engine);

    const reply = firstValueFrom(engine.send(ME, ROOM, text(), MAIN)).then(
      (result) => ({
        result,
        item: timeline.events().find((i) => i.transactionId === 'txn-1'),
      }),
    );
    w.fail(0, new MatrixError({ errcode: 'M_FORBIDDEN' }, 403));

    const { result, item } = await reply;
    expect(ok(result)).toEqual({ transactionId: 'txn-1', eventId: null });
    expect(item?.sendState).toEqual({ kind: 'failed', recoverable: true });
    timeline.subscription.unsubscribe();
  });

  it('uniqueId survives the remote echo', async () => {
    const w = sendingWorld();
    const engine = engineFor(w.client);
    const timeline = watch(engine);
    const reply = firstValueFrom(engine.send(ME, ROOM, text(), MAIN));
    const local = timeline.events().find((i) => i.transactionId === 'txn-1');
    w.confirm(0, '$e');
    await reply;

    const { echo } = w.sends[0];
    echo.handleRemoteEcho({
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'hello' },
      sender: ME,
      room_id: ROOM,
      event_id: '$e',
      origin_server_ts: 2,
      unsigned: { transaction_id: 'txn-1' },
    });
    w.room.emit(RoomEvent.LocalEchoUpdated, echo, w.room, '$e');
    await tick();

    const remote = timeline.events().find((i) => i.eventId === '$e');
    expect(local?.uniqueId).toBe('txn:txn-1');
    expect(remote).toMatchObject({
      uniqueId: 'txn:txn-1',
      transactionId: 'txn-1',
      sendState: null,
    });
    timeline.subscription.unsubscribe();
  });

  it('an offline echo is waiting, then sending on reconnect', async () => {
    const w = sendingWorld();
    const engine = engineFor(w.client);
    const timeline = watch(engine);
    const state = () =>
      timeline.events().find((i) => i.transactionId === 'txn-1')?.sendState;

    const reply = firstValueFrom(engine.send(ME, ROOM, text(), MAIN));
    w.fail(0, new ConnectionError('offline'));
    expect(ok(await reply)).toEqual({ transactionId: 'txn-1', eventId: null });
    expect(state()).toEqual({ kind: 'waiting' });

    // What the session's reconnect resend does to the echo.
    w.update(w.sends[0].echo, EventStatus.SENDING);
    await tick();
    expect(state()).toEqual({ kind: 'sending' });
    timeline.subscription.unsubscribe();
  });

  it('send text builds its content, in the thread when given one', async () => {
    const w = sendingWorld();
    const engine = engineFor(w.client);
    const message: OutgoingText = {
      msgtype: 'emote',
      body: 'waves at @Bob',
      formattedBody: 'waves at <a href="https://matrix.to/#/@bob:hs">@Bob</a>',
      mentions: { userIds: ['@bob:hs', '@bob:hs'], room: true },
    };

    const reply = firstValueFrom(
      engine.send(ME, ROOM, text(message), {
        threadRootId: '$root',
        replyTo: null,
      }),
    );
    w.confirm(0, '$e');
    await reply;

    expect(w.client.sendMessage).toHaveBeenCalledWith(
      ROOM,
      '$root',
      {
        msgtype: 'm.emote',
        body: 'waves at @Bob',
        format: 'org.matrix.custom.html',
        formatted_body:
          'waves at <a href="https://matrix.to/#/@bob:hs">@Bob</a>',
        'm.mentions': { user_ids: ['@bob:hs'], room: true },
      },
      'txn-1',
    );
  });

  it('send with replyTo quotes the loaded target and pings its author', async () => {
    const w = sendingWorld([msg('$q', '@bob:hs')]);
    const engine = engineFor(w.client);

    const reply = firstValueFrom(
      engine.send(ME, ROOM, text(), { threadRootId: null, replyTo: '$q' }),
    );
    w.confirm(0, '$e');
    await reply;

    expect(w.client.sendMessage).toHaveBeenCalledWith(
      ROOM,
      null,
      expect.objectContaining({
        msgtype: 'm.text',
        body: '> <@bob:hs> $q\n\nhello',
        format: 'org.matrix.custom.html',
        formatted_body: expect.stringMatching(
          /^<mx-reply>.*<\/mx-reply>hello$/,
        ),
        'm.relates_to': { 'm.in_reply_to': { event_id: '$q' } },
        'm.mentions': { user_ids: ['@bob:hs'] },
      }),
      'txn-1',
    );
  });

  it('send with replyTo fetches a target the room no longer holds', async () => {
    const w = sendingWorld();
    Object.assign(w.client, {
      fetchRoomEvent: vi.fn(() =>
        Promise.resolve({
          event_id: '$old',
          room_id: ROOM,
          type: 'm.room.message',
          sender: '@bob:hs',
          origin_server_ts: 1,
          content: { msgtype: 'm.text', body: 'trimmed text' },
        }),
      ),
    });
    const engine = engineFor(w.client);

    const reply = firstValueFrom(
      engine.send(ME, ROOM, text(), { threadRootId: null, replyTo: '$old' }),
    );
    await tick();
    w.confirm(0, '$e');
    await reply;

    expect(w.client.fetchRoomEvent).toHaveBeenCalledWith(ROOM, '$old');
    expect(w.sends[0].args[2]).toMatchObject({
      body: '> <@bob:hs> trimmed text\n\nhello',
    });
  });

  it('send with replyTo keeps the relation without a quote when the fetch fails', async () => {
    const w = sendingWorld();
    Object.assign(w.client, {
      fetchRoomEvent: vi.fn(() => Promise.reject(new Error('offline'))),
    });
    const engine = engineFor(w.client);

    const reply = firstValueFrom(
      engine.send(ME, ROOM, text(), { threadRootId: null, replyTo: '$old' }),
    );
    await tick();
    w.confirm(0, '$e');
    await reply;

    expect(w.sends[0].args[2]).toMatchObject({
      body: 'hello',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$old' } },
    });
  });

  it('send location, sticker and polls send the events Trinity sends today', async () => {
    const w = sendingWorld();
    const engine = engineFor(w.client);
    const messages: OutgoingMessage[] = [
      { kind: 'location', lat: 1.5, lng: 2.5, label: null },
      {
        kind: 'sticker',
        body: 'cat',
        url: 'mxc://hs/cat',
        info: { mimetype: 'image/png' },
      },
      {
        kind: 'poll-start',
        question: 'Lunch?',
        answers: ['Pizza', 'Soup'],
        maxSelections: 1,
      },
      { kind: 'poll-response', pollId: '$p', answerIds: ['a1'] },
      { kind: 'poll-end', pollId: '$p' },
    ];

    for (const [index, message] of messages.entries()) {
      const reply = firstValueFrom(engine.send(ME, ROOM, message, MAIN));
      w.confirm(index, `$e${index}`);
      await reply;
    }

    const txn = (n: number) => `txn-${n}`;
    expect(w.client.sendMessage).toHaveBeenCalledWith(
      ROOM,
      null,
      locationMessageContent(1.5, 2.5),
      txn(1),
    );
    expect(w.client.sendEvent.mock.calls).toEqual([
      [
        ROOM,
        null,
        'm.sticker',
        { body: 'cat', url: 'mxc://hs/cat', info: { mimetype: 'image/png' } },
        txn(2),
      ],
      [
        ROOM,
        null,
        M_POLL_START.name,
        pollStartContent('Lunch?', ['Pizza', 'Soup'], 1),
        txn(3),
      ],
      [
        ROOM,
        null,
        M_POLL_RESPONSE.name,
        pollResponseContent('$p', ['a1']),
        txn(4),
      ],
      [ROOM, null, M_POLL_END.name, pollEndContent('$p'), txn(5)],
    ]);
  });

  it('edit sends an m.replace of the item', async () => {
    const w = sendingWorld();
    const engine = engineFor(w.client);

    const reply = firstValueFrom(
      engine.edit(
        ME,
        ROOM,
        { eventId: '$a', transactionId: null },
        { ...HELLO, formattedBody: '<b>hello</b>' },
        { threadRootId: '$root' },
      ),
    );
    w.confirm(0, '$edit');

    expect(ok(await reply)).toBeNull();
    expect(w.client.sendMessage).toHaveBeenCalledWith(
      ROOM,
      '$root',
      {
        msgtype: 'm.text',
        body: '* hello',
        'm.mentions': {},
        format: 'org.matrix.custom.html',
        formatted_body: '* <b>hello</b>',
        'm.new_content': {
          msgtype: 'm.text',
          body: 'hello',
          format: 'org.matrix.custom.html',
          formatted_body: '<b>hello</b>',
          'm.mentions': {},
        },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$a' },
      },
      'txn-1',
    );
  });

  it('redact replies once the redacted item shows, in the thread when given one', async () => {
    const target = msg('$a');
    const w = sendingWorld([target]);
    w.client.redactEvent.mockImplementation(() => {
      target['isRedacted'] = () => true;
      w.room.emit(RoomEvent.Redaction);
      return Promise.resolve({ event_id: '$redaction' });
    });
    const engine = engineFor(w.client);
    const timeline = watch(engine);

    const result = await firstValueFrom(
      engine.redact(
        ME,
        ROOM,
        { eventId: '$a', transactionId: null },
        {
          threadRootId: '$root',
        },
      ),
    );

    expect(ok(result)).toBeNull();
    expect(timeline.events()[0]?.content.kind).toBe('redacted');
    expect(w.client.redactEvent).toHaveBeenCalledWith(ROOM, '$root', '$a');
    await firstValueFrom(
      engine.redact(
        ME,
        ROOM,
        { eventId: '$a', transactionId: null },
        NO_THREAD,
      ),
    );
    expect(w.client.redactEvent).toHaveBeenLastCalledWith(ROOM, '$a');
    timeline.subscription.unsubscribe();
  });

  it('a command settling while a page has landed replies after the page flush', async () => {
    const w = sendingWorld([msg('$b')], { token: 't1' });
    // The page's events are the harness's own fakes, not raw JSON.
    Object.assign(w.client, { getEventMapper: () => (raw: unknown) => raw });
    let respond: (value: unknown) => void = () => undefined;
    w.client.createMessagesRequest.mockReturnValue(
      new Promise((resolve) => (respond = resolve)),
    );
    let release: () => void = () => undefined;
    pageEnd.hold = new Promise<void>((resolve) => (release = resolve));
    const engine = engineFor(w.client);
    let sequence = 0;
    let flushedAt = 0;
    const timeline = watch(engine);
    timeline.subscription.add(
      engine.timeline(ME, ROOM, LIVE).subscribe((update) => {
        sequence += 1;
        const values =
          update.kind === 'items' && update.diffs[0]?.op === 'reset'
            ? update.diffs[0].values
            : [];
        if (
          update.kind === 'items' &&
          update.backPagination === 'idle' &&
          values.some((i) => i.kind === 'event' && i.eventId === '$a')
        ) {
          flushedAt ||= sequence;
        }
      }),
    );
    const sent = firstValueFrom(engine.send(ME, ROOM, text(), MAIN));
    w.fail(0, new ConnectionError('offline'));
    await sent;

    try {
      const page = firstValueFrom(engine.paginateBackwards(ME, ROOM, LIVE, 10));
      respond({ chunk: [msg('$a')], end: 't2' });
      await tick();
      // The page has landed and its flush is held: a command settles now.
      let repliedAt = 0;
      let shown: string[] = [];
      engine.cancelSend(ME, ROOM, 'txn-1').subscribe(() => {
        sequence += 1;
        repliedAt = sequence;
        shown = timeline.events().map((i) => i.eventId ?? i.uniqueId);
      });
      await tick();
      release();
      await page;
      await tick();

      expect(flushedAt).toBeGreaterThan(0);
      expect(repliedAt).toBeGreaterThan(flushedAt);
      expect(shown).toEqual(['$a', '$b']);
      expect(
        timeline.updates.some(
          (u) =>
            u.kind === 'items' &&
            u.diffs.length > 0 &&
            u.backPagination === 'paginating',
        ),
      ).toBe(false);
    } finally {
      pageEnd.hold = null;
      release();
      timeline.subscription.unsubscribe();
    }
  });

  it('toggleReaction adds an annotation, or redacts every own one', async () => {
    const w = sendingWorld();
    const mine = [
      { getId: () => '$r1', getSender: () => ME, isRedacted: () => false },
      { getId: () => '$r2', getSender: () => ME, isRedacted: () => false },
      {
        getId: () => '$r3',
        getSender: () => '@bob:hs',
        isRedacted: () => false,
      },
    ];
    let reacted = false;
    w.room.relations.getChildEventsForEvent = (() =>
      reacted
        ? { getSortedAnnotationsByKey: () => [['👍', new Set(mine)]] }
        : undefined) as never;
    const engine = engineFor(w.client);
    const key = { eventId: '$a', transactionId: null };

    const on = firstValueFrom(
      engine.toggleReaction(ME, ROOM, key, '👍', NO_THREAD),
    );
    w.confirm(0, '$r1');
    expect(ok(await on)).toBeNull();
    expect(w.client.sendEvent).toHaveBeenCalledWith(
      ROOM,
      null,
      'm.reaction',
      {
        'm.relates_to': { rel_type: 'm.annotation', event_id: '$a', key: '👍' },
      },
      'txn-1',
    );

    reacted = true;
    expect(
      ok(
        await firstValueFrom(
          engine.toggleReaction(ME, ROOM, key, '👍', { threadRootId: '$root' }),
        ),
      ),
    ).toBeNull();
    expect(w.client.redactEvent.mock.calls).toEqual([
      [ROOM, '$root', '$r1'],
      [ROOM, '$root', '$r2'],
    ]);

    const missing = await firstValueFrom(
      engine.toggleReaction(
        ME,
        ROOM,
        { eventId: '$gone', transactionId: null },
        '👍',
        NO_THREAD,
      ),
    );
    expect(failureCode(missing)).toBe('message-unavailable');
  });

  it('retrySend resends an unsent echo; anything else is message-unavailable', async () => {
    const w = sendingWorld();
    const engine = engineFor(w.client);
    const sent = firstValueFrom(engine.send(ME, ROOM, text(), MAIN));
    w.fail(0, new MatrixError({ errcode: 'M_UNKNOWN' }, 500));
    await sent;

    expect(
      ok(await firstValueFrom(engine.retrySend(ME, ROOM, 'txn-1'))),
    ).toBeNull();
    expect(w.client.resendEvent).toHaveBeenCalledWith(w.sends[0].echo, w.room);
    expect(
      failureCode(await firstValueFrom(engine.retrySend(ME, ROOM, 'txn-1'))),
    ).toBe('message-unavailable');
    expect(
      failureCode(await firstValueFrom(engine.retrySend(ME, ROOM, 'nope'))),
    ).toBe('message-unavailable');
  });

  it('cancelSend cancels an unsent echo; a sending or sent one is not-cancellable', async () => {
    const w = sendingWorld();
    const engine = engineFor(w.client);
    const first = firstValueFrom(engine.send(ME, ROOM, text(), MAIN));
    w.fail(0, new ConnectionError('offline'));
    await first;
    void firstValueFrom(engine.send(ME, ROOM, text(), MAIN));

    expect(
      ok(await firstValueFrom(engine.cancelSend(ME, ROOM, 'txn-1'))),
    ).toBeNull();
    expect(w.sends[0].echo.status).toBe(EventStatus.CANCELLED);
    expect(
      failureCode(await firstValueFrom(engine.cancelSend(ME, ROOM, 'txn-2'))),
    ).toBe('not-cancellable');
    w.confirm(1, '$e');
    await tick();
    expect(
      failureCode(await firstValueFrom(engine.cancelSend(ME, ROOM, 'txn-2'))),
    ).toBe('not-cancellable');
    expect(
      failureCode(await firstValueFrom(engine.cancelSend(ME, ROOM, 'nope'))),
    ).toBe('message-unavailable');
  });

  it('forward sends a copy, a sticker as m.sticker, and refuses what it cannot copy', async () => {
    const sticker = Object.assign(msg('$s'), {
      getType: () => 'm.sticker',
      getContent: () => ({ body: 'cat', url: 'mxc://hs/cat', info: {} }),
      getOriginalContent: () => ({
        body: 'cat',
        url: 'mxc://hs/cat',
        info: {},
      }),
    }) as FakeEvent;
    const redacted = msg('$x', '@bob:hs', {
      isRedacted: () => true,
      getContent: () => ({}),
      getOriginalContent: () => ({}),
    });
    const w = sendingWorld([msg('$a', '@bob:hs'), sticker, redacted]);
    const engine = engineFor(w.client);

    const copy = firstValueFrom(engine.forward(ME, ROOM, '$a', TARGET));
    w.confirm(0, '$copy');
    expect(ok(await copy)).toBeNull();
    const stickerCopy = firstValueFrom(engine.forward(ME, ROOM, '$s', TARGET));
    w.confirm(1, '$copy2');
    expect(ok(await stickerCopy)).toBeNull();

    expect(w.client.sendMessage).toHaveBeenCalledWith(
      TARGET,
      null,
      { msgtype: 'm.text', body: '$a', 'm.mentions': {} },
      'txn-1',
    );
    expect(w.client.sendEvent).toHaveBeenCalledWith(
      TARGET,
      null,
      'm.sticker',
      { body: 'cat', url: 'mxc://hs/cat', info: {}, 'm.mentions': {} },
      'txn-2',
    );
    expect(
      failureCode(await firstValueFrom(engine.forward(ME, ROOM, '$x', TARGET))),
    ).toBe('not-forwardable');
    expect(
      failureCode(
        await firstValueFrom(engine.forward(ME, ROOM, '$gone', TARGET)),
      ),
    ).toBe('message-unavailable');
  });

  describe('sendVoice', () => {
    const clip = {
      blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/ogg' }),
      mimeType: 'audio/ogg',
      durationMs: 1200,
      waveform: [0, 512, 1024],
    };

    function media() {
      return {
        uploadMedia: vi.fn(() =>
          of({
            msgtype: 'm.audio',
            body: 'voice-message.ogg',
            mxc: 'mxc://hs/voice',
            file: null,
            info: { mimetype: 'audio/ogg', size: 4 },
          }),
        ),
      };
    }

    it('uploads the clip and sends an m.audio voice message', async () => {
      const w = sendingWorld();
      Object.assign(w.client, {
        getCrypto: () => ({ isEncryptionEnabledInRoom: async () => false }),
      });
      const mediaService = media();
      const engine = engineFor(w.client, [
        { provide: MediaService, useValue: mediaService },
      ]);

      const reply = firstValueFrom(engine.sendVoice(ME, ROOM, clip));
      await tick();
      w.confirm(0, '$voice');

      expect(ok(await reply)).toBeNull();
      const [file, encrypt, , , client] = mediaService.uploadMedia.mock
        .calls[0] as unknown as [File, boolean, unknown, unknown, unknown];
      expect(file.name).toBe('voice-message.ogg');
      expect(file.type).toBe('audio/ogg');
      expect(encrypt).toBe(false);
      expect(client).toBe(w.client);
      expect(w.client.sendMessage).toHaveBeenCalledWith(
        ROOM,
        null,
        voiceMessageContent(
          { mxc: 'mxc://hs/voice', file: null, mimeType: 'audio/ogg', size: 4 },
          1200,
          [0, 512, 1024],
        ),
        'txn-1',
      );
    });

    it('sendVoice in an encrypted room without crypto is encryption-unavailable', async () => {
      const w = sendingWorld();
      Object.assign(w.room, { hasEncryptionStateEvent: () => true });
      const mediaService = media();
      const engine = engineFor(w.client, [
        { provide: MediaService, useValue: mediaService },
      ]);

      const result = await firstValueFrom(engine.sendVoice(ME, ROOM, clip));

      expect(failureCode(result)).toBe('encryption-unavailable');
      expect(mediaService.uploadMedia).not.toHaveBeenCalled();
      expect(w.client.sendMessage).not.toHaveBeenCalled();
    });
  });
});
