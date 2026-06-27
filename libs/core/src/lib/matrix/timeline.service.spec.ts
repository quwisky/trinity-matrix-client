import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { TimelineService } from './timeline.service';
import { MatrixClientService } from './matrix-client.service';

function fakeEvent(o: {
  id: string;
  sender: string;
  type?: string;
  body?: string;
  msgtype?: string;
  format?: string;
  formattedBody?: string;
  ts?: number;
  redacted?: boolean;
  decryptFail?: boolean;
  status?: string;
  edited?: boolean;
  editRelation?: boolean;
  replyTo?: string;
}) {
  return {
    getId: () => o.id,
    getSender: () => o.sender,
    replyEventId: o.replyTo,
    getRoomId: () => '!r:hs',
    getType: () => o.type ?? 'm.room.message',
    getTs: () => o.ts ?? 0,
    getContent: () => ({
      body: o.body ?? '',
      msgtype: o.msgtype ?? 'm.text',
      format: o.format,
      formatted_body: o.formattedBody,
    }),
    isRedacted: () => o.redacted ?? false,
    isDecryptionFailure: () => o.decryptFail ?? false,
    isRelation: (relType?: string) =>
      o.editRelation === true &&
      (relType === undefined || relType === 'm.replace'),
    replacingEvent: () => (o.edited ? {} : null),
    status: o.status ?? null,
  };
}

function fakeReaction(sender: string, id = '$re', redacted = false) {
  return {
    getSender: () => sender,
    getId: () => id,
    isRedacted: () => redacted,
  };
}

function fakeRelations(
  annotations: [string, Set<ReturnType<typeof fakeReaction>>][],
) {
  return { getSortedAnnotationsByKey: () => annotations };
}

function setup(
  events: ReturnType<typeof fakeEvent>[],
  sent: unknown[][] = [],
  reactions: Record<string, ReturnType<typeof fakeRelations>> = {},
) {
  const room = {
    roomId: '!r:hs',
    getLiveTimeline: () => ({
      getEvents: () => events,
      getPaginationToken: () => null,
    }),
    findEventById: (id: string) => events.find((e) => e.getId() === id),
    getMember: (id: string) => ({
      name: id === '@me:hs' ? 'Me' : 'Alice',
      getAvatarUrl: () => null,
    }),
    relations: {
      getChildEventsForEvent: (id: string) => reactions[id],
    },
    on: () => {},
    off: () => {},
  };
  const client = {
    baseUrl: 'https://hs',
    getRoom: () => room,
    getUserId: () => '@me:hs',
    on: () => {},
    off: () => {},
    sendReadReceipt: () => Promise.resolve({}),
    scrollback: () => Promise.resolve(room),
    sendTextMessage: (_rid: string, body: string) => {
      sent.push(['text', body]);
      return Promise.resolve({});
    },
    sendHtmlMessage: (_rid: string, body: string, html: string) => {
      sent.push(['html', body, html]);
      return Promise.resolve({});
    },
    sendMessage: (_rid: string, content: unknown) => {
      sent.push(['message', content]);
      return Promise.resolve({});
    },
    redactEvent: (_rid: string, eventId: string) => {
      sent.push(['redact', eventId]);
      return Promise.resolve({});
    },
    sendEvent: (_rid: string, type: string, content: unknown) => {
      sent.push(['event', type, content]);
      return Promise.resolve({});
    },
  };
  const matrix = {
    isInitialized: true,
    instance: client,
  } as unknown as MatrixClientService;

  TestBed.configureTestingModule({
    providers: [
      TimelineService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  const svc = TestBed.inject(TimelineService);
  svc.open('!r:hs');
  return svc;
}

describe('TimelineService', () => {
  it('maps message events to views and drops non-messages', () => {
    const svc = setup([
      fakeEvent({ id: '$1', sender: '@alice:hs', body: 'hi' }),
      fakeEvent({ id: '$m', sender: '@alice:hs', type: 'm.room.member' }),
      fakeEvent({ id: '$2', sender: '@me:hs', body: 'yo' }),
    ]);

    const msgs = svc.messages();
    expect(msgs.map((m) => m.id)).toEqual(['$1', '$2']);
    expect(msgs[0]).toMatchObject({
      senderName: 'Alice',
      body: 'hi',
      isOwn: false,
      kind: 'text',
    });
    expect(msgs[1].isOwn).toBe(true);
  });

  it('exposes formatted_body HTML for markdown messages', () => {
    const svc = setup([
      fakeEvent({
        id: '$md',
        sender: '@a:hs',
        body: '**hi**',
        format: 'org.matrix.custom.html',
        formattedBody: '<strong>hi</strong>',
      }),
      fakeEvent({ id: '$plain', sender: '@a:hs', body: 'plain' }),
    ]);

    const [formatted, plain] = svc.messages();
    expect(formatted.html).toBe('<strong>hi</strong>');
    expect(formatted.body).toBe('**hi**');
    expect(plain.html).toBeNull();
  });

  it('sends plain text as-is and markdown as formatted HTML', async () => {
    const sent: unknown[][] = [];
    const svc = setup([], sent);

    await firstValueFrom(svc.send('hello there'));
    await firstValueFrom(svc.send('**bold**'));

    expect(sent[0]).toEqual(['text', 'hello there']);
    expect(sent[1][0]).toBe('html');
    expect(sent[1][1]).toBe('**bold**');
    expect(sent[1][2]).toContain('<strong>bold</strong>');
  });

  it('edits a message as an m.replace with new content', async () => {
    const sent: unknown[][] = [];
    const svc = setup([], sent);

    await firstValueFrom(svc.edit('$orig', 'fixed **text**'));

    expect(sent[0][0]).toBe('message');
    const content = sent[0][1] as Record<string, unknown>;
    expect(content['m.relates_to']).toEqual({
      rel_type: 'm.replace',
      event_id: '$orig',
    });
    expect(content['body']).toBe('* fixed **text**');
    const newContent = content['m.new_content'] as Record<string, unknown>;
    expect(newContent['body']).toBe('fixed **text**');
    expect(newContent['formatted_body']).toContain('<strong>text</strong>');
  });

  it('redacts a message', async () => {
    const sent: unknown[][] = [];
    const svc = setup([], sent);

    await firstValueFrom(svc.redact('$x'));

    expect(sent[0]).toEqual(['redact', '$x']);
  });

  it('aggregates reactions onto messages and flags the user’s own', () => {
    const svc = setup(
      [fakeEvent({ id: '$1', sender: '@a:hs', body: 'hi' })],
      [],
      {
        $1: fakeRelations([
          ['👍', new Set([fakeReaction('@me:hs'), fakeReaction('@a:hs')])],
          ['❤️', new Set([fakeReaction('@a:hs')])],
        ]),
      },
    );

    expect(svc.messages()[0].reactions).toEqual([
      { key: '👍', count: 2, reacted: true },
      { key: '❤️', count: 1, reacted: false },
    ]);
  });

  it('sends an annotation when reacting to a message', async () => {
    const sent: unknown[][] = [];
    const svc = setup([], sent);

    await firstValueFrom(svc.toggleReaction('$m', '👍'));

    expect(sent[0][0]).toBe('event');
    expect(sent[0][1]).toBe('m.reaction');
    expect((sent[0][2] as Record<string, unknown>)['m.relates_to']).toEqual({
      rel_type: 'm.annotation',
      event_id: '$m',
      key: '👍',
    });
  });

  it('redacts the existing reaction when toggling it off', async () => {
    const sent: unknown[][] = [];
    const svc = setup([], sent, {
      $m: fakeRelations([['👍', new Set([fakeReaction('@me:hs', '$mine')])]]),
    });

    await firstValueFrom(svc.toggleReaction('$m', '👍'));

    expect(sent[0]).toEqual(['redact', '$mine']);
  });

  it('sends a reply with an in_reply_to relation and a quote fallback', async () => {
    const sent: unknown[][] = [];
    const svc = setup(
      [fakeEvent({ id: '$orig', sender: '@a:hs', body: 'hello world' })],
      sent,
    );

    await firstValueFrom(svc.reply('$orig', 'hi back'));

    expect(sent[0][0]).toBe('message');
    const content = sent[0][1] as Record<string, unknown>;
    expect(content['m.relates_to']).toEqual({
      'm.in_reply_to': { event_id: '$orig' },
    });
    expect(content['body']).toBe('> <@a:hs> hello world\n\nhi back');
    // Rich-reply HTML fallback so other clients render (and strip) it correctly.
    expect(content['format']).toBe('org.matrix.custom.html');
    expect(content['formatted_body']).toContain('<mx-reply>');
    expect(content['formatted_body']).toContain('</mx-reply>hi back');
  });

  it('maps a reply preview and strips the quote fallback from the body', () => {
    const svc = setup([
      fakeEvent({ id: '$orig', sender: '@a:hs', body: 'original text' }),
      fakeEvent({
        id: '$reply',
        sender: '@me:hs',
        body: '> <@a:hs> original text\n\nmy reply',
        replyTo: '$orig',
      }),
    ]);

    const reply = svc.messages().find((m) => m.id === '$reply');
    expect(reply?.body).toBe('my reply'); // fallback stripped
    expect(reply?.replyTo).toEqual({
      id: '$orig',
      senderName: 'Alice',
      senderInitial: 'A',
      senderAvatarUrl: null,
      body: 'original text',
    });
  });

  it('marks edited messages and hides the edit events', () => {
    const svc = setup([
      fakeEvent({ id: '$1', sender: '@a:hs', body: 'orig', edited: true }),
      fakeEvent({
        id: '$e',
        sender: '@a:hs',
        body: '* new',
        editRelation: true,
      }),
      fakeEvent({ id: '$2', sender: '@a:hs', body: 'plain' }),
    ]);

    const msgs = svc.messages();
    expect(msgs.map((m) => m.id)).toEqual(['$1', '$2']); // edit event hidden
    expect(msgs[0].edited).toBe(true);
    expect(msgs[1].edited).toBe(false);
  });

  it('maps local-echo status', () => {
    const svc = setup([
      fakeEvent({ id: '$s', sender: '@me:hs', body: 'x', status: 'sending' }),
      fakeEvent({ id: '$f', sender: '@me:hs', body: 'y', status: 'not_sent' }),
      fakeEvent({ id: '$ok', sender: '@me:hs', body: 'z' }),
    ]);
    const [sending, failed, ok] = svc.messages();
    expect(sending.status).toBe('sending');
    expect(failed.status).toBe('failed');
    expect(ok.status).toBeNull();
  });

  it('flags redacted and decryption-failed messages', () => {
    const svc = setup([
      fakeEvent({ id: '$r', sender: '@a:hs', redacted: true }),
      fakeEvent({ id: '$e', sender: '@a:hs', decryptFail: true }),
    ]);

    const [redacted, failed] = svc.messages();
    expect(redacted.kind).toBe('redacted');
    expect(failed.decryptionFailed).toBe(true);
    expect(failed.body).toContain('Unable to decrypt');
  });

  it('resets loadingOlder after a failed scrollback so pagination can retry', async () => {
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => [],
        getPaginationToken: () => 'tok',
      }),
      getMember: () => ({ name: 'A', getAvatarUrl: () => null }),
      relations: { getChildEventsForEvent: () => undefined },
      on: () => {},
      off: () => {},
    };
    const client = {
      baseUrl: 'https://hs',
      getRoom: () => room,
      getUserId: () => '@me:hs',
      on: () => {},
      off: () => {},
      sendReadReceipt: () => Promise.resolve({}),
      scrollback: () => Promise.reject(new Error('network')),
    };
    const matrix = {
      isInitialized: true,
      instance: client,
    } as unknown as MatrixClientService;
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        { provide: MatrixClientService, useValue: matrix },
      ],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');

    await expect(firstValueFrom(svc.loadOlder())).rejects.toThrow('network');
    expect(svc.loadingOlder()).toBe(false); // finalize cleared it; not stuck
  });

  it('sends the read receipt to the latest confirmed event, skipping pending echoes', () => {
    const received: { getId: () => string }[] = [];
    const events = [
      fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' }), // confirmed
      fakeEvent({
        id: '$pending',
        sender: '@me:hs',
        body: 'echo',
        status: 'sending',
      }),
    ];
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
      }),
      getMember: () => ({ name: 'A', getAvatarUrl: () => null }),
      relations: { getChildEventsForEvent: () => undefined },
      on: () => {},
      off: () => {},
    };
    const client = {
      baseUrl: 'https://hs',
      getRoom: () => room,
      getUserId: () => '@me:hs',
      on: () => {},
      off: () => {},
      sendReadReceipt: (e: { getId: () => string }) => {
        received.push(e);
        return Promise.resolve({});
      },
      scrollback: () => Promise.resolve(room),
    };
    const matrix = {
      isInitialized: true,
      instance: client,
    } as unknown as MatrixClientService;
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        { provide: MatrixClientService, useValue: matrix },
      ],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');

    expect(received).toHaveLength(1);
    expect(received[0].getId()).toBe('$a'); // not the pending echo
  });
});
