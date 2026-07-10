import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { RoomEvent, RoomStateEvent } from 'matrix-js-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineService } from './timeline.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { MediaService, type UploadedMedia } from '@trinity/data-access-media';
import { TYPING_REFRESH_MS } from '@trinity/util-matrix';

/** A MediaService mock whose uploadMedia echoes a descriptor for the room's mode. */
function mediaProvider() {
  return MockProvider(MediaService, {
    uploadMedia: (_file: File, encrypt: boolean) =>
      of<UploadedMedia>(
        encrypt
          ? {
              msgtype: 'm.image' as UploadedMedia['msgtype'],
              body: 'pic.png',
              mxc: null,
              file: {
                url: 'mxc://hs/enc',
                v: 'v2',
                key: {} as JsonWebKey,
                iv: 'iv',
                hashes: { sha256: 'h' },
              },
              info: { mimetype: 'image/png', size: 4 },
            }
          : {
              msgtype: 'm.image' as UploadedMedia['msgtype'],
              body: 'pic.png',
              mxc: 'mxc://hs/up',
              file: null,
              info: { mimetype: 'image/png', size: 4 },
            },
      ),
  });
}

/** Wrap a fake matrix-js-sdk client as a MatrixClientService mock. */
function matrixProvider(client: unknown, isInitialized = true) {
  return MockProvider(MatrixClientService, {
    isInitialized,
    instance: client,
  } as Partial<MatrixClientService>);
}

/**
 * A MatrixClientService mock whose `instance` follows a mutable holder — mirroring
 * the real getter, which resolves the *active* account on every access. Lets a test
 * switch accounts and observe when the service actually reads the client.
 */
function switchableMatrixProvider(active: { client: unknown }) {
  return {
    provide: MatrixClientService,
    useValue: {
      isInitialized: true,
      get instance() {
        return active.client;
      },
    } as unknown as MatrixClientService,
  };
}

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
  url?: string;
  filename?: string;
  file?: unknown;
  info?: Record<string, unknown>;
  relatesTo?: unknown;
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
      // Media fields are only included when supplied, so non-media events keep
      // their previous content shape exactly.
      ...(o.url !== undefined ? { url: o.url } : {}),
      ...(o.filename !== undefined ? { filename: o.filename } : {}),
      ...(o.file !== undefined ? { file: o.file } : {}),
      ...(o.info !== undefined ? { info: o.info } : {}),
      ...(o.relatesTo !== undefined ? { 'm.relates_to': o.relatesTo } : {}),
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

/** A room member as {@link TimelineService.refreshTyping} reads it. */
function fakeMember(userId: string, typing: boolean, name = userId) {
  return { userId, typing, name, roomId: '!r:hs' };
}

function fakeRoom(
  events: ReturnType<typeof fakeEvent>[],
  reactions: Record<string, ReturnType<typeof fakeRelations>> = {},
  encrypted = false,
  members: ReturnType<typeof fakeMember>[] = [],
  fullyReadEventId: string | null = null,
  receiptsByEvent: Record<string, string[]> = {},
) {
  return {
    roomId: '!r:hs',
    getLiveTimeline: () => ({
      getEvents: () => events,
      getPaginationToken: () => null,
    }),
    findEventById: (id: string) => events.find((e) => e.getId() === id),
    getMember: (id: string) => ({
      name: id === '@me:hs' ? 'Me' : 'Alice',
      getMxcAvatarUrl: () => null,
    }),
    getMembers: () => members,
    getUsersReadUpTo: (event: { getId: () => string }) =>
      receiptsByEvent[event.getId()] ?? [],
    getAccountData: (type: string) =>
      type === 'm.fully_read' && fullyReadEventId
        ? { getContent: () => ({ event_id: fullyReadEventId }) }
        : undefined,
    relations: {
      getChildEventsForEvent: (
        id: string,
        relType?: string,
        evType?: string,
      ) =>
        relType === 'm.annotation' && evType === 'm.reaction'
          ? reactions[id]
          : undefined,
    },
    hasEncryptionStateEvent: () => encrypted,
    on: () => {},
    off: () => {},
  };
}

/** A fake matrix-js-sdk client that records everything it is asked to send. */
function fakeClient(room: ReturnType<typeof fakeRoom>, sent: unknown[][]) {
  // Captured event listeners keyed by event name, so a test can fire e.g. the
  // RoomMember.typing handler the service registers in open().
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    baseUrl: 'https://hs',
    getRoom: () => room,
    getUserId: () => '@me:hs',
    handlers,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    },
    off: () => {},
    sendTyping: (_rid: string, isTyping: boolean) => {
      sent.push(['typing', isTyping]);
      return Promise.resolve({});
    },
    sendReadReceipt: () => Promise.resolve({}),
    setRoomReadMarkers: vi.fn(() => Promise.resolve({})),
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
}

function setup(
  events: ReturnType<typeof fakeEvent>[],
  sent: unknown[][] = [],
  reactions: Record<string, ReturnType<typeof fakeRelations>> = {},
  encrypted = false,
) {
  const room = fakeRoom(events, reactions, encrypted);
  const client = fakeClient(room, sent);

  TestBed.configureTestingModule({
    providers: [TimelineService, matrixProvider(client), mediaProvider()],
  });
  const svc = TestBed.inject(TimelineService);
  svc.open('!r:hs');
  return svc;
}

describe('TimelineService', () => {
  beforeEach(() => {
    // Viewing a room = the window is focused (the normal case). markRead only acks
    // while focused; the unfocused / refocus paths are exercised explicitly below.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

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

  it('sanitizes hostile formatted_body (drops scripts and event handlers)', () => {
    const svc = setup([
      fakeEvent({
        id: '$x',
        sender: '@a:hs',
        body: 'hi',
        format: 'org.matrix.custom.html',
        formattedBody:
          '<img src="https://x.test/a.png" onerror="alert(1)">' +
          '<script>alert(2)</script><strong>ok</strong>',
      }),
    ]);

    const html = svc.messages()[0].html ?? '';
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).toContain('<strong>ok</strong>');
  });

  it('strips remote image sources (no tracking-pixel auto-fetch)', () => {
    const svc = setup([
      fakeEvent({
        id: '$img',
        sender: '@a:hs',
        body: 'pic',
        format: 'org.matrix.custom.html',
        formattedBody:
          '<img src="https://attacker.test/x.gif" alt="leak">' +
          '<img src="mxc://hs/abc" alt="ok"><strong>text</strong>',
      }),
    ]);

    const html = svc.messages()[0].html ?? '';
    expect(html).not.toContain('attacker.test'); // remote src dropped
    expect(html).toContain('mxc://hs/abc'); // local mxc src kept
    expect(html).toContain('alt="leak"'); // node itself survives, just no src
    expect(html).toContain('<strong>text</strong>');
  });

  it('restricts the class attribute to the Matrix-sanctioned allowlist', () => {
    const svc = setup([
      fakeEvent({
        id: '$cls',
        sender: '@a:hs',
        body: 'code',
        format: 'org.matrix.custom.html',
        formattedBody:
          '<pre><code class="language-python evil-toolbar">x = 1</code></pre>' +
          '<span class="ion-page header-bar">spoof</span>',
      }),
    ]);

    const html = svc.messages()[0].html ?? '';
    expect(html).toContain('language-python'); // sanctioned class survives
    expect(html).not.toContain('evil-toolbar'); // sibling token dropped
    expect(html).not.toContain('ion-page'); // borrowed app/Ionic class dropped
    expect(html).not.toContain('header-bar');
  });

  it('neutralizes javascript: links and strips the new-tab target', () => {
    const svc = setup([
      fakeEvent({
        id: '$l',
        sender: '@a:hs',
        body: 'link',
        format: 'org.matrix.custom.html',
        formattedBody:
          '<a href="javascript:alert(1)" target="_blank">x</a>' +
          '<a href="https://ok.test">ok</a>',
      }),
    ]);

    const html = svc.messages()[0].html ?? '';
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('target'); // no reverse-tabnabbing surface
    expect(html).toContain('https://ok.test'); // safe link preserved
  });

  it('sends plain text as-is and markdown as formatted HTML', async () => {
    const sent: unknown[][] = [];
    const svc = setup([], sent);

    await firstValueFrom(svc.send('hello there'));
    await firstValueFrom(svc.send('**bold**'));

    // Both go through sendMessage(content) now so mentions can add m.mentions.
    expect(sent[0][0]).toBe('message');
    expect(sent[0][1]).toEqual({ msgtype: 'm.text', body: 'hello there' });
    expect(sent[1][0]).toBe('message');
    const rich = sent[1][1] as Record<string, unknown>;
    expect(rich['body']).toBe('**bold**');
    expect(rich['format']).toBe('org.matrix.custom.html');
    expect(rich['formatted_body']).toContain('<strong>bold</strong>');
  });

  it('forwards a message content to another room, dropping any relation', async () => {
    const sent: unknown[][] = [];
    const svc = setup(
      [
        fakeEvent({
          id: '$src',
          sender: '@a:hs',
          body: 'forward me',
          relatesTo: { rel_type: 'm.thread', event_id: '$root' },
        }),
      ],
      sent,
    );

    await firstValueFrom(svc.forwardMessage('!r:hs', '$src', '!target:hs'));

    const message = sent.find((c) => c[0] === 'message');
    const content = message?.[1] as Record<string, unknown>;
    expect(content['body']).toBe('forward me');
    expect(content['m.relates_to']).toBeUndefined(); // standalone, not a thread reply
  });

  it('errors when forwarding an event that cannot be found', async () => {
    const svc = setup([]);
    await expect(
      firstValueFrom(svc.forwardMessage('!r:hs', '$missing', '!target:hs')),
    ).rejects.toThrow();
  });

  it('adds m.mentions and a matrix.to pill when a message mentions someone', async () => {
    const sent: unknown[][] = [];
    const svc = setup([], sent);

    await firstValueFrom(
      svc.send('hi @Bob', [{ userId: '@bob:hs', display: '@Bob' }]),
    );

    const content = sent[0][1] as Record<string, unknown>;
    expect(content['m.mentions']).toEqual({ user_ids: ['@bob:hs'] });
    expect(content['formatted_body']).toContain(
      '<a href="https://matrix.to/#/@bob:hs">@Bob</a>',
    );
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
      senderAvatarMxc: null,
      body: 'original text',
    });
  });

  it('refreshes a reply preview when the quoted sender’s member loads late', () => {
    const events = [
      fakeEvent({ id: '$orig', sender: '@a:hs', body: 'original text' }),
      fakeEvent({
        id: '$reply',
        sender: '@me:hs',
        body: '> <@a:hs> original text\n\nmy reply',
        replyTo: '$orig',
      }),
    ];
    // The quoted sender isn't in room state yet (lazy loading), then arrives.
    let aliceLoaded = false;
    let memberHandler: ((...a: unknown[]) => void) | undefined;
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
      }),
      findEventById: (id: string) => events.find((e) => e.getId() === id),
      getMember: (id: string) => {
        if (id === '@me:hs') {
          return { name: 'Me', getMxcAvatarUrl: () => null };
        }
        return aliceLoaded
          ? { name: 'Alice', getMxcAvatarUrl: () => 'mxc://hs/av' }
          : null;
      },
      relations: { getChildEventsForEvent: () => undefined },
      hasEncryptionStateEvent: () => false,
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        if (ev === RoomStateEvent.Members) {
          memberHandler = cb;
        }
      },
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
    };
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client)],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');

    // Member absent → preview falls back to the raw mxid, no avatar.
    const before = svc.messages().find((m) => m.id === '$reply');
    expect(before?.replyTo?.senderName).toBe('@a:hs');
    expect(before?.replyTo?.senderAvatarMxc).toBeNull();

    // The member's profile arrives; the room re-emits its state Members event.
    aliceLoaded = true;
    memberHandler?.({}, {}, { roomId: '!r:hs', userId: '@a:hs' });

    const after = svc.messages().find((m) => m.id === '$reply');
    expect(after?.replyTo?.senderName).toBe('Alice');
    expect(after?.replyTo?.senderAvatarMxc).toBe('mxc://hs/av');
  });

  it('does not re-project when an unreferenced member changes', () => {
    const events = [fakeEvent({ id: '$1', sender: '@a:hs', body: 'hi' })];
    let memberCalls = 0;
    let memberHandler: ((...a: unknown[]) => void) | undefined;
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
      }),
      findEventById: (id: string) => events.find((e) => e.getId() === id),
      getMember: (id: string) => {
        memberCalls++;
        return {
          name: id === '@me:hs' ? 'Me' : 'Alice',
          getMxcAvatarUrl: () => null,
        };
      },
      relations: { getChildEventsForEvent: () => undefined },
      hasEncryptionStateEvent: () => false,
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        if (ev === RoomStateEvent.Members) {
          memberHandler = cb;
        }
      },
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
    };
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client)],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');
    const baseline = memberCalls;

    // A member the timeline doesn't render → gated out, no re-projection.
    memberHandler?.({}, {}, { roomId: '!r:hs', userId: '@stranger:hs' });
    expect(memberCalls).toBe(baseline);

    // A rendered sender → re-projects (reads members again).
    memberHandler?.({}, {}, { roomId: '!r:hs', userId: '@a:hs' });
    expect(memberCalls).toBeGreaterThan(baseline);
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
      getMember: () => ({ name: 'A', getMxcAvatarUrl: () => null }),
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
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client)],
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
      getMember: () => ({ name: 'A', getMxcAvatarUrl: () => null }),
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
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client)],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');

    expect(received).toHaveLength(1);
    expect(received[0].getId()).toBe('$a'); // not the pending echo
  });

  it('does not ack the open room while the window is unfocused (badge accrues)', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false); // app not in focus
    const received: { getId: () => string }[] = [];
    const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
      }),
      getMember: () => ({ name: 'A', getMxcAvatarUrl: () => null }),
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
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client)],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');

    expect(received).toHaveLength(0); // unfocused → held back so unread accrues
  });

  it('re-acks the open room when the window regains focus', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false); // start unfocused
    const received: { getId: () => string }[] = [];
    const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
      }),
      getMember: () => ({ name: 'A', getMxcAvatarUrl: () => null }),
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
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client)],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');
    expect(received).toHaveLength(0); // unfocused: not acked yet

    vi.spyOn(document, 'hasFocus').mockReturnValue(true); // user returns
    window.dispatchEvent(new Event('focus')); // → onFocus → markRead

    expect(received.map((e) => e.getId())).toEqual(['$a']);
  });

  it('close() removes the focus listener so a closed room is not re-acked on focus', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false); // start unfocused
    const received: { getId: () => string }[] = [];
    const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
      }),
      getMember: () => ({ name: 'A', getMxcAvatarUrl: () => null }),
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
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client)],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');
    expect(received).toHaveLength(0); // unfocused: not acked yet

    svc.close();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true); // user returns
    window.dispatchEvent(new Event('focus')); // no room is open — must be a no-op

    expect(received).toHaveLength(0); // the closed room is never re-acked
  });

  it('re-acks with the latest live event on refocus, not a stale snapshot', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false); // start unfocused
    const received: { getId: () => string }[] = [];
    const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
      }),
      getMember: () => ({ name: 'A', getMxcAvatarUrl: () => null }),
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
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client)],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');
    expect(received).toHaveLength(0); // unfocused: not acked yet

    // The live timeline gains a newer event while still unfocused (no refresh
    // is triggered for it in this scenario — e.g. it arrived just before focus).
    events.push(fakeEvent({ id: '$b', sender: '@a:hs', body: 'yo' }));

    vi.spyOn(document, 'hasFocus').mockReturnValue(true); // user returns
    window.dispatchEvent(new Event('focus')); // → onFocus → markRead(live timeline)

    expect(received.map((e) => e.getId())).toEqual(['$b']); // targets the newer event
  });

  it('re-acks a live message in the open room, deduped across refreshes', () => {
    const received: { getId: () => string }[] = [];
    const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
    let timelineHandler: (() => void) | undefined;
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
      }),
      getMember: () => ({ name: 'A', getMxcAvatarUrl: () => null }),
      relations: { getChildEventsForEvent: () => undefined },
      on: (ev: string, cb: () => void) => {
        if (ev === RoomEvent.Timeline) {
          timelineHandler = cb;
        }
      },
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
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client)],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');

    expect(received.map((e) => e.getId())).toEqual(['$a']); // initial ack

    // A live message arrives while the room is open → re-ack the new latest.
    events.push(fakeEvent({ id: '$b', sender: '@a:hs', body: 'yo' }));
    timelineHandler?.();
    expect(received.map((e) => e.getId())).toEqual(['$a', '$b']);

    // A refresh that doesn't change the latest (e.g. backfill) must not re-send.
    timelineHandler?.();
    expect(received.map((e) => e.getId())).toEqual(['$a', '$b']);
  });

  describe('media messages', () => {
    it('projects an m.image event to an image MediaPayload', () => {
      const svc = setup([
        fakeEvent({
          id: '$img',
          sender: '@a:hs',
          msgtype: 'm.image',
          body: 'pic.png',
          url: 'mxc://hs/abc',
          info: { mimetype: 'image/png', w: 800, h: 600, size: 1234 },
        }),
      ]);

      const m = svc.messages()[0];
      expect(m.kind).toBe('image');
      expect(m.body).toBe('pic.png'); // body falls back to the filename
      expect(m.media).toMatchObject({
        kind: 'image',
        mxc: 'mxc://hs/abc',
        file: null,
        mimeType: 'image/png',
        width: 800,
        height: 600,
        size: 1234,
        filename: 'pic.png',
      });
      expect(m.caption).toBeNull(); // no MSC2530 filename → no caption
    });

    it('projects an MSC2530 caption alongside a media message', () => {
      const svc = setup([
        fakeEvent({
          id: '$capimg',
          sender: '@a:hs',
          msgtype: 'm.image',
          body: 'look at this', // body is the caption when filename is present
          filename: 'pic.png',
          url: 'mxc://hs/abc',
          info: { mimetype: 'image/png' },
        }),
      ]);

      const m = svc.messages()[0];
      expect(m.media?.filename).toBe('pic.png'); // real name, not the caption
      expect(m.caption).toBe('look at this');
      expect(m.captionHtml).toBeNull(); // plain caption
    });

    it('projects a rich (markdown) MSC2530 caption', () => {
      const svc = setup([
        fakeEvent({
          id: '$richcap',
          sender: '@a:hs',
          msgtype: 'm.image',
          body: 'look **here**',
          format: 'org.matrix.custom.html',
          formattedBody: '<p>look <strong>here</strong></p>',
          filename: 'pic.png',
          url: 'mxc://hs/abc',
          info: { mimetype: 'image/png' },
        }),
      ]);

      const m = svc.messages()[0];
      expect(m.caption).toBe('look **here**');
      expect(m.captionHtml).toContain('<strong>here</strong>'); // sanitized rich caption
    });

    it('projects an m.file event to a file MediaPayload', () => {
      const svc = setup([
        fakeEvent({
          id: '$file',
          sender: '@a:hs',
          msgtype: 'm.file',
          body: 'report.pdf',
          url: 'mxc://hs/doc',
          info: { mimetype: 'application/pdf', size: 9000 },
        }),
      ]);

      const m = svc.messages()[0];
      expect(m.kind).toBe('file');
      expect(m.media).toMatchObject({
        kind: 'file',
        mxc: 'mxc://hs/doc',
        mimeType: 'application/pdf',
        size: 9000,
        filename: 'report.pdf',
      });
    });

    it('downgrades a script-bearing image MIME (svg) to a download-only file', () => {
      const svc = setup([
        fakeEvent({
          id: '$svg',
          sender: '@a:hs',
          msgtype: 'm.image',
          body: 'logo.svg',
          url: 'mxc://hs/svg',
          info: { mimetype: 'image/svg+xml', w: 10, h: 10 },
        }),
      ]);

      const m = svc.messages()[0];
      expect(m.kind).toBe('file'); // not rendered inline
      expect(m.media?.kind).toBe('file');
      expect(m.media?.mimeType).toBe('image/svg+xml'); // MIME preserved on the payload
    });

    it('falls back to unsupported with no media when a media event has neither url nor file', () => {
      const svc = setup([
        fakeEvent({
          id: '$bad',
          sender: '@a:hs',
          msgtype: 'm.image',
          body: '',
          info: { mimetype: 'image/png' },
        }),
      ]);

      const m = svc.messages()[0];
      expect(m.kind).toBe('unsupported');
      expect(m.media).toBeNull();
      expect(m.body).toBe('[image]'); // label fallback when body is empty too
    });
  });

  describe('sendMedia', () => {
    const png = () =>
      new File([new Uint8Array([1, 2, 3, 4])], 'pic.png', {
        type: 'image/png',
      });
    const gif = () =>
      new File([new Uint8Array([1, 2, 3, 4])], 'trinity.gif', {
        type: 'image/gif',
      });

    it('sends a plaintext url media event in an unencrypted room', async () => {
      const sent: unknown[][] = [];
      const svc = setup([], sent); // encrypted = false

      await firstValueFrom(svc.sendMedia(png(), ''));

      expect(sent[0][0]).toBe('message');
      const content = sent[0][1] as Record<string, unknown>;
      expect(content['msgtype']).toBe('m.image');
      expect(content['url']).toBe('mxc://hs/up');
      expect(content['file']).toBeUndefined();
      expect(content['info']).toMatchObject({ mimetype: 'image/png' });
      expect(content['body']).toBe('pic.png'); // no caption → body is the filename
      expect(content['filename']).toBeUndefined();
    });

    it('sends a caption as an MSC2530 body + filename (rich when formatted)', async () => {
      const sent: unknown[][] = [];
      const svc = setup([], sent);

      await firstValueFrom(svc.sendMedia(png(), 'a **bold** caption'));

      const content = sent[0][1] as Record<string, unknown>;
      expect(content['body']).toBe('a **bold** caption'); // body carries the caption
      expect(content['filename']).toBe('pic.png'); // real file name preserved
      expect(content['format']).toBe('org.matrix.custom.html');
      expect(content['formatted_body']).toContain('<strong>bold</strong>');
    });

    it('sends an encrypted file media event in an E2EE room', async () => {
      const sent: unknown[][] = [];
      const svc = setup([], sent, {}, true); // encrypted = true

      await firstValueFrom(svc.sendMedia(png(), ''));

      const content = sent[0][1] as Record<string, unknown>;
      expect(content['url']).toBeUndefined();
      expect(content['file']).toMatchObject({ url: 'mxc://hs/enc', v: 'v2' });
    });

    it('is a no-op for an empty file', async () => {
      const sent: unknown[][] = [];
      const svc = setup([], sent);

      await firstValueFrom(
        svc.sendMedia(
          new File([], 'empty.bin', { type: 'application/octet-stream' }),
          '',
        ),
      );

      expect(sent).toHaveLength(0);
    });

    it('sends through the active account, re-resolved on every send', async () => {
      // Multi-account: `MatrixClientService.instance` resolves whichever account is
      // active at access time. sendMedia must therefore read it per send and never
      // cache a client — otherwise a GIF (or any attachment) chosen after the user
      // switches accounts would upload and post under the *previous* account.
      const sentA: unknown[][] = [];
      const sentB: unknown[][] = [];
      const room = fakeRoom([]);
      const active = { client: fakeClient(room, sentA) as unknown };
      const clientB = fakeClient(room, sentB);

      TestBed.configureTestingModule({
        providers: [
          TimelineService,
          switchableMatrixProvider(active),
          mediaProvider(),
        ],
      });
      const svc = TestBed.inject(TimelineService);
      svc.open('!r:hs');

      await firstValueFrom(svc.sendMedia(gif(), ''));
      expect(sentA).toHaveLength(1);
      expect(sentB).toHaveLength(0);

      active.client = clientB; // the user picks another account in the switcher

      await firstValueFrom(svc.sendMedia(gif(), ''));
      expect(sentB).toHaveLength(1); // landed on the newly-active account
      expect(sentA).toHaveLength(1); // and not a second time on the previous one
      expect((sentB[0][1] as Record<string, unknown>)['msgtype']).toBe(
        'm.image',
      );
    });

    it('resolves the active account on subscribe, not when called', async () => {
      // These actions are documented as cold: calling them must do nothing until
      // subscribed. So the account must be read at *subscribe* time — resolving it
      // eagerly means an Observable held across an account switch (or replayed by a
      // retry operator) would upload and post under the account that is no longer
      // active.
      const sentA: unknown[][] = [];
      const sentB: unknown[][] = [];
      const room = fakeRoom([]);
      const active = { client: fakeClient(room, sentA) as unknown };
      const clientB = fakeClient(room, sentB);

      TestBed.configureTestingModule({
        providers: [
          TimelineService,
          switchableMatrixProvider(active),
          mediaProvider(),
        ],
      });
      const svc = TestBed.inject(TimelineService);
      svc.open('!r:hs');

      const send$ = svc.sendMedia(gif(), ''); // built while A is active…
      active.client = clientB; // …account switched before anyone subscribes
      await firstValueFrom(send$);

      expect(sentA).toHaveLength(0); // nothing escaped to the stale account
      expect(sentB).toHaveLength(1);
    });

    it('is inert when the room closed before subscribe', async () => {
      // The same coldness contract for the room half of the context: a send built
      // against a room the user has since navigated away from must not fire.
      const sent: unknown[][] = [];
      const svc = setup([], sent);

      const send$ = svc.sendMedia(gif(), '');
      svc.close();
      await firstValueFrom(send$);

      expect(sent).toHaveLength(0);
    });
  });

  describe('typing', () => {
    /** Open a room with the given members and return handles for typing assertions. */
    function setupTyping(members: ReturnType<typeof fakeMember>[] = []) {
      const sent: unknown[][] = [];
      const room = fakeRoom([], {}, false, members);
      const client = fakeClient(room, sent);
      TestBed.configureTestingModule({
        providers: [TimelineService, matrixProvider(client), mediaProvider()],
      });
      const svc = TestBed.inject(TimelineService);
      svc.open('!r:hs');
      return { svc, client, sent };
    }

    /** Only the typing calls the client recorded, in order. */
    const typingCalls = (sent: unknown[][]) =>
      sent.filter((call) => call[0] === 'typing');

    it('broadcasts a typing notification when the composer reports typing', () => {
      const { svc, sent } = setupTyping();
      svc.setTyping(true);
      expect(typingCalls(sent)).toEqual([['typing', true]]);
    });

    it('throttles repeated starts, then refreshes once the interval elapses', () => {
      let now = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const { svc, sent } = setupTyping();

      svc.setTyping(true);
      svc.setTyping(true); // still within the refresh window → no second request
      expect(typingCalls(sent)).toEqual([['typing', true]]);

      now += TYPING_REFRESH_MS + 1; // window elapsed → one refresh allowed
      svc.setTyping(true);
      expect(typingCalls(sent)).toEqual([
        ['typing', true],
        ['typing', true],
      ]);
    });

    it('stops typing only when currently marked as typing', () => {
      const { svc, sent } = setupTyping();

      svc.setTyping(false); // never started → nothing to clear
      expect(typingCalls(sent)).toEqual([]);

      svc.setTyping(true);
      svc.setTyping(false);
      expect(typingCalls(sent)).toEqual([
        ['typing', true],
        ['typing', false],
      ]);
    });

    it('stops typing when the room closes', () => {
      const { svc, sent } = setupTyping();
      svc.setTyping(true);
      svc.close();
      expect(typingCalls(sent)).toContainEqual(['typing', false]);
    });

    it('projects other typing members into typingNames, excluding self', () => {
      const { svc, client } = setupTyping([
        fakeMember('@alice:hs', true, 'Alice'),
        fakeMember('@me:hs', true, 'Me'), // the local user never lists themselves
        fakeMember('@bob:hs', false, 'Bob'), // present but not typing
      ]);

      // Fire the RoomMember.typing listener the service registered in open().
      client.handlers.get('RoomMember.typing')?.(
        {},
        fakeMember('@alice:hs', true, 'Alice'),
      );

      expect(svc.typingNames()).toEqual(['Alice']);
    });

    it('ignores typing changes from other rooms', () => {
      const { svc, client } = setupTyping([fakeMember('@alice:hs', true)]);
      client.handlers.get('RoomMember.typing')?.(
        {},
        { userId: '@x:hs', typing: true, name: 'X', roomId: '!other:hs' },
      );
      expect(svc.typingNames()).toEqual([]);
    });
  });

  describe('unread divider', () => {
    /** Open a room whose fully-read marker sits at `fullyReadEventId`. */
    function setupUnread(
      events: ReturnType<typeof fakeEvent>[],
      fullyReadEventId: string | null,
    ) {
      const room = fakeRoom(events, {}, false, [], fullyReadEventId);
      const client = fakeClient(room, []);
      TestBed.configureTestingModule({
        providers: [TimelineService, matrixProvider(client), mediaProvider()],
      });
      const svc = TestBed.inject(TimelineService);
      svc.open('!r:hs');
      return { svc, client };
    }

    const msgs = [
      fakeEvent({ id: '$1', sender: '@alice:hs', body: 'a' }),
      fakeEvent({ id: '$2', sender: '@alice:hs', body: 'b' }),
      fakeEvent({ id: '$3', sender: '@alice:hs', body: 'c' }),
    ];

    it('points at the first message after the read marker', () => {
      const { svc } = setupUnread(msgs, '$1');
      expect(svc.firstUnreadId()).toBe('$2');
    });

    it('is null when the marker is the newest message', () => {
      const { svc } = setupUnread(msgs, '$3');
      expect(svc.firstUnreadId()).toBeNull();
    });

    it('is null when there is no read marker', () => {
      const { svc } = setupUnread(msgs, null);
      expect(svc.firstUnreadId()).toBeNull();
    });

    it('is null when the marker is not among the loaded messages', () => {
      const { svc } = setupUnread(msgs, '$missing');
      expect(svc.firstUnreadId()).toBeNull();
    });

    it('skips the user’s own messages after the marker', () => {
      const { svc } = setupUnread(
        [
          fakeEvent({ id: '$1', sender: '@alice:hs', body: 'a' }),
          fakeEvent({ id: '$2', sender: '@me:hs', body: 'mine' }),
          fakeEvent({ id: '$3', sender: '@alice:hs', body: 'theirs' }),
        ],
        '$1',
      );
      expect(svc.firstUnreadId()).toBe('$3');
    });

    it('stays put as the room is read (marker captured on open)', () => {
      const { svc } = setupUnread(msgs, '$1');
      // markRead ran on open and advanced the server marker, but the divider anchor
      // was captured beforehand, so it still points at $2.
      expect(svc.firstUnreadId()).toBe('$2');
    });

    it('advances the persisted fully-read marker when marking read', () => {
      const { client } = setupUnread(msgs, '$1');
      expect(client.setRoomReadMarkers).toHaveBeenCalledWith('!r:hs', '$3');
    });

    it('clears the divider when the room closes', () => {
      const { svc } = setupUnread(msgs, '$1');
      svc.close();
      expect(svc.firstUnreadId()).toBeNull();
    });
  });

  describe('read receipts (seen by)', () => {
    function setupReceipts(
      events: ReturnType<typeof fakeEvent>[],
      receiptsByEvent: Record<string, string[]>,
    ) {
      const room = fakeRoom(events, {}, false, [], null, receiptsByEvent);
      const client = fakeClient(room, []);
      TestBed.configureTestingModule({
        providers: [TimelineService, matrixProvider(client), mediaProvider()],
      });
      const svc = TestBed.inject(TimelineService);
      svc.open('!r:hs');
      return svc;
    }

    it('projects the members who read up to each message, excluding self', () => {
      const svc = setupReceipts(
        [
          fakeEvent({ id: '$1', sender: '@alice:hs', body: 'a' }),
          fakeEvent({ id: '$2', sender: '@alice:hs', body: 'b' }),
        ],
        { $1: ['@bob:hs', '@me:hs'], $2: [] }, // self is filtered out
      );

      const [first, second] = svc.messages();
      expect(first.readReceipts.map((r) => r.userId)).toEqual(['@bob:hs']);
      expect(first.readReceipts[0].name).toBe('Alice'); // resolved from room state
      expect(second.readReceipts).toEqual([]);
    });
  });
});
