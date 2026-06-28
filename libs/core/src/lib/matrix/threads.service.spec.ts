import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { RoomEvent, ThreadEvent } from 'matrix-js-sdk';
import { describe, expect, it } from 'vitest';
import { ThreadsService } from './threads.service';
import { MatrixClientService } from './matrix-client.service';
import { MediaService, type UploadedMedia } from './media.service';

const MEMBERS: Record<string, string> = {
  '@me:hs': 'Me',
  '@a:hs': 'Alice',
  '@b:hs': 'Bob',
};

/** Minimal mutable event-emitter shim so tests can fire SDK listeners. */
function emitter() {
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  return {
    on(ev: string, h: (...a: unknown[]) => void) {
      (handlers[ev] ??= []).push(h);
    },
    off(ev: string, h: (...a: unknown[]) => void) {
      handlers[ev] = (handlers[ev] ?? []).filter((x) => x !== h);
    },
    emit(ev: string, ...args: unknown[]) {
      (handlers[ev] ?? []).slice().forEach((h) => h(...args));
    },
  };
}

function fakeEvent(o: {
  id: string;
  sender: string;
  body?: string;
  ts?: number;
  type?: string;
  redacted?: boolean;
  decryptFail?: boolean;
  replyTo?: string;
  status?: string | null;
}) {
  return {
    getId: () => o.id,
    getSender: () => o.sender,
    getTs: () => o.ts ?? 0,
    getType: () => o.type ?? 'm.room.message',
    getRoomId: () => '!r:hs',
    getContent: () => ({ body: o.body ?? '', msgtype: 'm.text' }),
    isRedacted: () => o.redacted ?? false,
    isDecryptionFailure: () => o.decryptFail ?? false,
    isRelation: () => false,
    replacingEvent: () => null,
    replyEventId: o.replyTo,
    status: o.status ?? null,
  };
}

type FakeEvent = ReturnType<typeof fakeEvent>;

function fakeReaction(sender: string, id = '$re', redacted = false) {
  return {
    getSender: () => sender,
    getId: () => id,
    isRedacted: () => redacted,
  };
}

function fakeRelations(annotations: [string, Set<unknown>][]) {
  return { getSortedAnnotationsByKey: () => annotations };
}

function fakeThread(o: {
  id: string;
  rootEvent?: FakeEvent;
  events?: FakeEvent[];
  replyToEvent?: FakeEvent | null;
  length?: number;
}) {
  return {
    id: o.id,
    rootEvent: o.rootEvent,
    events: o.events ?? [],
    replyToEvent: o.replyToEvent ?? null,
    length: o.length ?? o.events?.length ?? 0,
    ...emitter(),
  };
}

type FakeThread = ReturnType<typeof fakeThread>;

/** A MediaService stub whose uploadMedia echoes a plaintext-url image descriptor. */
function fakeMediaService() {
  return {
    uploadMedia: () =>
      of<UploadedMedia>({
        msgtype: 'm.image' as UploadedMedia['msgtype'],
        body: 'pic.png',
        mxc: 'mxc://hs/up',
        file: null,
        info: { mimetype: 'image/png', size: 4 },
      }),
  } as unknown as MediaService;
}

function setup(
  threads: FakeThread[],
  sent: unknown[][] = [],
  reactions: Record<string, ReturnType<typeof fakeRelations>> = {},
) {
  const all = [
    ...threads.flatMap((t) => [
      ...(t.rootEvent ? [t.rootEvent] : []),
      ...t.events,
    ]),
  ];
  const room = {
    roomId: '!r:hs',
    getThreads: () => threads,
    getThread: (id: string) => threads.find((t) => t.id === id) ?? null,
    findEventById: (id: string) => all.find((e) => e.getId() === id),
    getMember: (id: string) => ({
      name: MEMBERS[id] ?? id,
      getMxcAvatarUrl: () => null,
    }),
    relations: {
      getChildEventsForEvent: (id: string) => reactions[id],
    },
    hasEncryptionStateEvent: () => false,
    ...emitter(),
  };
  const client = {
    getRoom: () => room,
    getUserId: () => '@me:hs',
    sendTextMessage: (_rid: string, threadId: string, body: string) => {
      sent.push(['text', threadId, body]);
      return Promise.resolve({});
    },
    sendHtmlMessage: (
      _rid: string,
      threadId: string,
      body: string,
      html: string,
    ) => {
      sent.push(['html', threadId, body, html]);
      return Promise.resolve({});
    },
    sendMessage: (_rid: string, threadId: string, content: unknown) => {
      sent.push(['message', threadId, content]);
      return Promise.resolve({});
    },
    redactEvent: (_rid: string, threadId: string, eventId: string) => {
      sent.push(['redact', threadId, eventId]);
      return Promise.resolve({});
    },
    sendEvent: (
      _rid: string,
      threadId: string,
      type: string,
      content: unknown,
    ) => {
      sent.push(['event', threadId, type, content]);
      return Promise.resolve({});
    },
    resendEvent: (event: FakeEvent) => {
      sent.push(['resend', event.getId()]);
      return Promise.resolve({});
    },
    ...emitter(),
  };
  const matrix = {
    isInitialized: true,
    instance: client,
  } as unknown as MatrixClientService;
  TestBed.configureTestingModule({
    providers: [
      ThreadsService,
      { provide: MatrixClientService, useValue: matrix },
      { provide: MediaService, useValue: fakeMediaService() },
    ],
  });
  const svc = TestBed.inject(ThreadsService);
  return { svc, room, sent };
}

describe('ThreadsService', () => {
  it('projects a room’s threads into summaries keyed by root id', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const reply = fakeEvent({
      id: '$r1',
      sender: '@b:hs',
      body: 'a reply',
      ts: 1000,
    });
    const { svc } = setup([
      fakeThread({
        id: '$root',
        rootEvent: root,
        events: [root, reply],
        replyToEvent: reply,
        length: 1,
      }),
    ]);
    svc.open('!r:hs');

    const summary = svc.summaries()['$root'];
    expect(summary).toMatchObject({
      rootEventId: '$root',
      replyCount: 1,
      latestReplyTs: 1000,
      latestReplyPreview: 'a reply',
      latestReplySenderName: 'Bob',
    });
    // Distinct participants (root author + replier), deduped, in first-seen order.
    expect(summary.participants.map((p) => p.id)).toEqual(['@a:hs', '@b:hs']);
    expect(summary.participants[0]).toMatchObject({
      name: 'Alice',
      initial: 'A',
    });
  });

  it('opens a thread into root-first, decrypted message views', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const reply = fakeEvent({ id: '$r1', sender: '@b:hs', body: 'a reply' });
    const { svc } = setup([
      fakeThread({ id: '$root', rootEvent: root, events: [root, reply] }),
    ]);
    svc.openThread('!r:hs', '$root');

    const msgs = svc.threadMessages();
    expect(msgs.map((m) => m.id)).toEqual(['$root', '$r1']);
    expect(msgs[0].body).toBe('root msg');
    expect(svc.openThreadRootId()).toBe('$root');
  });

  it('prepends the root when the thread timeline omits it', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const reply = fakeEvent({ id: '$r1', sender: '@b:hs', body: 'a reply' });
    const { svc } = setup([
      // events lacks the root — it should still appear first.
      fakeThread({ id: '$root', rootEvent: root, events: [reply] }),
    ]);
    svc.openThread('!r:hs', '$root');

    expect(svc.threadMessages().map((m) => m.id)).toEqual(['$root', '$r1']);
  });

  it('renders the unable-to-decrypt fallback for an E2EE failure in a thread', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const failed = fakeEvent({ id: '$f', sender: '@b:hs', decryptFail: true });
    const { svc } = setup([
      fakeThread({ id: '$root', rootEvent: root, events: [root, failed] }),
    ]);
    svc.openThread('!r:hs', '$root');

    const failedView = svc.threadMessages().find((m) => m.id === '$f');
    expect(failedView?.decryptionFailed).toBe(true);
    expect(failedView?.body).toContain('Unable to decrypt');
  });

  it('clears state on close / closeThread', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const { svc } = setup([
      fakeThread({ id: '$root', rootEvent: root, events: [root] }),
    ]);

    svc.open('!r:hs');
    expect(Object.keys(svc.summaries())).toHaveLength(1);
    svc.close();
    expect(svc.summaries()).toEqual({});

    svc.openThread('!r:hs', '$root');
    expect(svc.threadMessages()).toHaveLength(1);
    svc.closeThread();
    expect(svc.threadMessages()).toEqual([]);
    expect(svc.openThreadRootId()).toBeNull();
  });

  describe('in-thread composing', () => {
    function openedThread() {
      const root = fakeEvent({
        id: '$root',
        sender: '@a:hs',
        body: 'root msg',
      });
      const reply = fakeEvent({ id: '$r1', sender: '@b:hs', body: 'a reply' });
      const out = setup(
        [fakeThread({ id: '$root', rootEvent: root, events: [root, reply] })],
        [],
        {},
      );
      out.svc.openThread('!r:hs', '$root');
      return out;
    }

    it('sends a plain-text message into the thread (thread root as threadId)', async () => {
      const { svc, sent } = openedThread();

      await firstValueFrom(svc.sendToThread('hello thread'));

      // The SDK adds the m.thread relation when given the threadId — here we assert
      // the call carries the thread root so the message stays in the thread.
      expect(sent[0]).toEqual(['text', '$root', 'hello thread']);
    });

    it('sends markdown as formatted HTML into the thread', async () => {
      const { svc, sent } = openedThread();

      await firstValueFrom(svc.sendToThread('**bold**'));

      expect(sent[0][0]).toBe('html');
      expect(sent[0][1]).toBe('$root'); // threadId
      expect(sent[0][2]).toBe('**bold**');
      expect(sent[0][3]).toContain('<strong>bold</strong>');
    });

    it('edits an own thread message via an m.replace, scoped to the thread', async () => {
      const { svc, sent } = openedThread();

      await firstValueFrom(svc.editInThread('$r1', 'fixed text'));

      expect(sent[0][0]).toBe('message');
      expect(sent[0][1]).toBe('$root'); // threadId routes the edit into the thread
      const content = sent[0][2] as Record<string, unknown>;
      expect(content['m.relates_to']).toEqual({
        rel_type: 'm.replace',
        event_id: '$r1',
      });
      expect(content['body']).toBe('* fixed text');
      expect(
        (content['m.new_content'] as Record<string, unknown>)['body'],
      ).toBe('fixed text');
    });

    it('replies to a thread message with an in_reply_to + quote fallback', async () => {
      const { svc, sent } = openedThread();

      await firstValueFrom(svc.replyInThread('$r1', 'replying'));

      expect(sent[0][0]).toBe('message');
      expect(sent[0][1]).toBe('$root'); // threadId; SDK sets is_falling_back: false
      const content = sent[0][2] as Record<string, unknown>;
      expect(content['m.relates_to']).toEqual({
        'm.in_reply_to': { event_id: '$r1' },
      });
      expect(content['body']).toBe('> <@b:hs> a reply\n\nreplying');
      expect(content['formatted_body']).toContain('<mx-reply>');
      expect(content['formatted_body']).toContain('</mx-reply>replying');
    });

    it('redacts a thread message', async () => {
      const { svc, sent } = openedThread();

      await firstValueFrom(svc.redactInThread('$r1'));

      expect(sent[0]).toEqual(['redact', '$root', '$r1']);
    });

    it('sends an annotation when reacting to a thread message', async () => {
      const { svc, sent } = openedThread();

      await firstValueFrom(svc.toggleReactionInThread('$r1', '👍'));

      expect(sent[0][0]).toBe('event');
      expect(sent[0][1]).toBe('$root'); // threadId
      expect(sent[0][2]).toBe('m.reaction');
      expect((sent[0][3] as Record<string, unknown>)['m.relates_to']).toEqual({
        rel_type: 'm.annotation',
        event_id: '$r1',
        key: '👍',
      });
    });

    it('redacts the existing reaction when toggling it off in a thread', async () => {
      const root = fakeEvent({
        id: '$root',
        sender: '@a:hs',
        body: 'root msg',
      });
      const reply = fakeEvent({ id: '$r1', sender: '@b:hs', body: 'a reply' });
      const { svc, sent } = setup(
        [fakeThread({ id: '$root', rootEvent: root, events: [root, reply] })],
        [],
        {
          $r1: fakeRelations([
            ['👍', new Set([fakeReaction('@me:hs', '$mine')])],
          ]),
        },
      );
      svc.openThread('!r:hs', '$root');

      await firstValueFrom(svc.toggleReactionInThread('$r1', '👍'));

      expect(sent[0]).toEqual(['redact', '$root', '$mine']);
    });

    it('sends media into the thread, routed by the thread root id', async () => {
      const { svc, sent } = openedThread();

      await firstValueFrom(
        svc.sendMediaToThread(
          new File([new Uint8Array([1, 2, 3, 4])], 'pic.png', {
            type: 'image/png',
          }),
        ),
      );

      expect(sent[0][0]).toBe('message');
      expect(sent[0][1]).toBe('$root'); // threadId
      const content = sent[0][2] as Record<string, unknown>;
      expect(content['msgtype']).toBe('m.image');
      expect(content['url']).toBe('mxc://hs/up');
    });

    it('retries a failed thread echo via resendEvent', () => {
      const root = fakeEvent({
        id: '$root',
        sender: '@a:hs',
        body: 'root msg',
      });
      const echo = fakeEvent({
        id: '$echo',
        sender: '@me:hs',
        body: 'oops',
        status: 'not_sent',
      });
      const { svc, sent } = setup([
        fakeThread({ id: '$root', rootEvent: root, events: [root, echo] }),
      ]);
      svc.openThread('!r:hs', '$root');

      svc.retryInThread('$echo');

      expect(sent[0]).toEqual(['resend', '$echo']);
    });

    it('reflects an optimistic echo and re-maps its send status on update', () => {
      const root = fakeEvent({
        id: '$root',
        sender: '@a:hs',
        body: 'root msg',
      });
      const thread = fakeThread({
        id: '$root',
        rootEvent: root,
        events: [root],
      });
      const { svc, room } = setup([thread]);
      svc.openThread('!r:hs', '$root');
      expect(svc.threadMessages().map((m) => m.id)).toEqual(['$root']);

      // Optimistic local echo: a pending reply appears in the thread timeline.
      const echo = fakeEvent({
        id: '$echo',
        sender: '@me:hs',
        body: 'hi',
        status: 'sending',
      });
      thread.events.push(echo);
      thread.emit(ThreadEvent.NewReply);
      let echoView = svc.threadMessages().find((m) => m.id === '$echo');
      expect(echoView?.status).toBe('sending');

      // The send confirms (status clears) — the room-level LocalEchoUpdated listener
      // re-maps the resolved event, just like the main timeline.
      echo.status = 'sent';
      room.emit(RoomEvent.LocalEchoUpdated);
      echoView = svc.threadMessages().find((m) => m.id === '$echo');
      expect(echoView?.status).toBeNull();
    });

    it('is a no-op when no thread is open', async () => {
      const { svc, sent } = setup([]);
      // openThread was never called → no active thread context.
      await firstValueFrom(svc.sendToThread('nope'));
      expect(sent).toHaveLength(0);
    });
  });
});
