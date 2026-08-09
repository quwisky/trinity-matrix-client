import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import {
  Direction,
  ReceiptType,
  RoomEvent,
  RoomStateEvent,
} from 'matrix-js-sdk';
import {
  EventShieldColour,
  EventShieldReason,
} from 'matrix-js-sdk/lib/crypto-api';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import { TimelineService } from './timeline.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MediaService, type UploadedMedia } from '@trinity/data-access/media';
import {
  PrivacySettingsService,
  SystemLineSettingsService,
} from '@trinity/platform-native';
import { TYPING_REFRESH_MS } from '@trinity/util/matrix';

/** A PrivacySettingsService mock with a fixed send-read-receipts preference. */
function privacyProvider(sendReadReceipts: boolean) {
  return MockProvider(PrivacySettingsService, {
    sendReadReceipts: signal(sendReadReceipts).asReadonly(),
  });
}

/**
 * A SystemLineSettingsService mock with writable category toggles, so a test can hide a
 * category (and flip it back) the way Settings → Appearance does.
 */
function systemLinesProvider(
  shown: {
    membership?: boolean;
    profile?: boolean;
    room?: boolean;
  } = {},
) {
  const membership = signal(shown.membership ?? true);
  const profile = signal(shown.profile ?? true);
  const roomChanges = signal(shown.room ?? true);
  return {
    provider: MockProvider(SystemLineSettingsService, {
      showMembership: membership.asReadonly(),
      showProfile: profile.asReadonly(),
      showRoomChanges: roomChanges.asReadonly(),
    }),
    membership,
    profile,
    roomChanges,
  };
}

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
  encrypted?: boolean;
  status?: string;
  edited?: boolean;
  editRelation?: boolean;
  replyTo?: string;
  url?: string;
  filename?: string;
  file?: unknown;
  info?: Record<string, unknown>;
  relatesTo?: unknown;
  voice?: boolean;
  waveform?: number[];
  durationMs?: number;
  state?: boolean;
  stateKey?: string;
  content?: Record<string, unknown>;
  prevContent?: Record<string, unknown>;
}) {
  return {
    getId: () => o.id,
    getSender: () => o.sender,
    replyEventId: o.replyTo,
    getRoomId: () => '!r:hs',
    getType: () => o.type ?? 'm.room.message',
    getTs: () => o.ts ?? 0,
    isState: () => o.state ?? o.stateKey !== undefined,
    getStateKey: () => o.stateKey,
    getPrevContent: () => o.prevContent ?? {},
    getContent: () =>
      o.content ?? {
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
        ...(o.voice ? { 'org.matrix.msc3245.voice': {} } : {}),
        ...(o.voice || o.waveform || o.durationMs !== undefined
          ? {
              'org.matrix.msc1767.audio': {
                ...(o.durationMs !== undefined
                  ? { duration: o.durationMs }
                  : {}),
                ...(o.waveform !== undefined ? { waveform: o.waveform } : {}),
              },
            }
          : {}),
      },
    isRedacted: () => o.redacted ?? false,
    isDecryptionFailure: () => o.decryptFail ?? false,
    isEncrypted: () => o.encrypted ?? false,
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
  power: { mine?: number; redact?: number } = {},
) {
  const myPower = power.mine ?? 0;
  const redactLevel = power.redact ?? 50;
  return {
    roomId: '!r:hs',
    // Room state hangs off the live timeline (what liveRoomState() reads, and what
    // the SDK's deprecated `currentState` aliased).
    getLiveTimeline: () => ({
      getEvents: () => events,
      getPaginationToken: () => null,
      getState: () => ({
        hasSufficientPowerLevelFor: (_action: string, level: number) =>
          level >= redactLevel,
      }),
    }),
    findEventById: (id: string) => events.find((e) => e.getId() === id),
    getMember: (id: string) => ({
      name: id === '@me:hs' ? 'Me' : 'Alice',
      getMxcAvatarUrl: () => null,
      powerLevel: id === '@me:hs' ? myPower : 0,
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
  power: { mine?: number; redact?: number } = {},
) {
  const room = fakeRoom(events, reactions, encrypted, [], null, {}, power);
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
      // A no-op membership repeat (unchanged name + avatar) has nothing to show → dropped.
      fakeEvent({
        id: '$m',
        sender: '@alice:hs',
        type: 'm.room.member',
        stateKey: '@alice:hs',
        content: { membership: 'join', displayname: 'Alice' },
        prevContent: { membership: 'join', displayname: 'Alice' },
      }),
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

  it('renders room state and membership changes as system rows', () => {
    const svc = setup([
      fakeEvent({ id: '$1', sender: '@alice:hs', body: 'hi' }),
      fakeEvent({
        id: '$n',
        sender: '@alice:hs',
        type: 'm.room.name',
        stateKey: '',
        content: { name: 'General' },
      }),
      fakeEvent({
        id: '$j',
        sender: '@alice:hs',
        type: 'm.room.member',
        stateKey: '@alice:hs',
        content: { membership: 'join' },
      }),
      fakeEvent({ id: '$2', sender: '@me:hs', body: 'yo' }),
    ]);

    const msgs = svc.messages();
    expect(msgs.map((m) => m.id)).toEqual(['$1', '$n', '$j', '$2']);
    expect(msgs[1]).toMatchObject({
      kind: 'event',
      summary: 'Alice set the room name to "General"',
    });
    expect(msgs[2]).toMatchObject({
      kind: 'event',
      summary: 'Alice joined the room',
    });
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
    // `m.mentions` rides along on EVERY message, empty when there is nothing to say — its
    // presence is what makes the server skip the legacy body-matching push rules.
    expect(sent[0][1]).toEqual({
      msgtype: 'm.text',
      body: 'hello there',
      'm.mentions': {},
    });
    expect(sent[1][0]).toBe('message');
    const rich = sent[1][1] as Record<string, unknown>;
    expect(rich['body']).toBe('**bold**');
    expect(rich['format']).toBe('org.matrix.custom.html');
    expect(rich['formatted_body']).toContain('<strong>bold</strong>');
  });

  it('sends a shared location as m.location', async () => {
    const sent: unknown[][] = [];
    const svc = setup([], sent);

    await firstValueFrom(svc.sendLocation(52.51, 13.38));

    expect(sent[0][0]).toBe('message');
    expect(sent[0][1]).toMatchObject({
      msgtype: 'm.location',
      geo_uri: 'geo:52.51,13.38',
    });
  });

  it('interprets a /me slash command as an emote', async () => {
    const sent: unknown[][] = [];
    const svc = setup([], sent);

    await firstValueFrom(svc.send('/me waves'));

    expect(sent[0][0]).toBe('message');
    expect(sent[0][1]).toMatchObject({ msgtype: 'm.emote', body: 'waves' });
  });

  it('appends the shrug for a /shrug slash command', async () => {
    const sent: unknown[][] = [];
    const svc = setup([], sent);

    await firstValueFrom(svc.send('/shrug'));

    expect(sent[0][1]).toEqual({
      msgtype: 'm.text',
      body: '¯\\_(ツ)_/¯',
      'm.mentions': {},
    });
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

  it('creates a poll via an m.poll.start event', async () => {
    const sent: unknown[][] = [];
    const svc = setup([], sent);
    await firstValueFrom(svc.createPoll('Best fruit?', ['Apple', 'Pear']));
    const event = sent.find((c) => c[0] === 'event');
    expect(event?.[1]).toBe('m.poll.start');
    const content = event?.[2] as Record<string, { answers: unknown[] }>;
    expect(content['m.poll.start'].answers).toHaveLength(2);
  });

  it('rejects a poll with fewer than two options', async () => {
    const sent: unknown[][] = [];
    const svc = setup([], sent);
    await firstValueFrom(svc.createPoll('Best fruit?', ['Apple', '  ']));
    expect(sent.some((c) => c[0] === 'event')).toBe(false);
  });

  it('casts a poll vote via an m.poll.response event', async () => {
    const sent: unknown[][] = [];
    const svc = setup([], sent);
    await firstValueFrom(svc.votePoll('$p', 'a1'));
    const event = sent.find((c) => c[0] === 'event');
    expect(event?.[1]).toBe('m.poll.response');
    const content = event?.[2] as Record<string, { answers: string[] }>;
    expect(content['m.poll.response'].answers).toEqual(['a1']);
  });

  it('ends a poll via an m.poll.end event', async () => {
    const sent: unknown[][] = [];
    const svc = setup([], sent);
    await firstValueFrom(svc.endPoll('$p'));
    expect(sent.find((c) => c[0] === 'event')?.[1]).toBe('m.poll.end');
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

  it('canRedactOthers is false for a regular member (power below redact level)', () => {
    const svc = setup([], [], {}, false, { mine: 0, redact: 50 });
    expect(svc.canRedactOthers()).toBe(false);
  });

  it('canRedactOthers is true for a moderator (power meets redact level)', () => {
    const svc = setup([], [], {}, false, { mine: 50, redact: 50 });
    expect(svc.canRedactOthers()).toBe(true);
  });

  it('canRedactOthers resets to false when the room closes', () => {
    const svc = setup([], [], {}, false, { mine: 100, redact: 50 });
    expect(svc.canRedactOthers()).toBe(true);

    svc.close();
    expect(svc.canRedactOthers()).toBe(false);
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
      // "You" leads the named reactors so the pill's hint reads naturally.
      { key: '👍', count: 2, reacted: true, reactors: ['You', 'Alice'] },
      { key: '❤️', count: 1, reacted: false, reactors: ['Alice'] },
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

  it('refreshes a reply preview when the quoted sender’s member loads late', async () => {
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
        getState: () => undefined,
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
    await Promise.resolve(); // re-projection is coalesced into a microtask

    const after = svc.messages().find((m) => m.id === '$reply');
    expect(after?.replyTo?.senderName).toBe('Alice');
    expect(after?.replyTo?.senderAvatarMxc).toBe('mxc://hs/av');
  });

  it('refreshes a membership system line when the target member loads late', async () => {
    const events = [
      fakeEvent({
        id: '$inv',
        sender: '@me:hs',
        type: 'm.room.member',
        stateKey: '@bob:hs',
        content: { membership: 'invite' }, // no displayname → resolved via room state
      }),
    ];
    let bobLoaded = false;
    let memberHandler: ((...a: unknown[]) => void) | undefined;
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
        getState: () => undefined,
      }),
      findEventById: (id: string) => events.find((e) => e.getId() === id),
      getMember: (id: string) => {
        if (id === '@me:hs') {
          return { name: 'Me', getMxcAvatarUrl: () => null };
        }
        return bobLoaded ? { name: 'Bob', getMxcAvatarUrl: () => null } : null;
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

    // Target member absent → the line names the raw mxid.
    expect(svc.messages().find((m) => m.id === '$inv')?.summary).toBe(
      'Me invited @bob:hs',
    );

    // Bob's profile arrives; the room re-emits its state Members event for him.
    bobLoaded = true;
    memberHandler?.({}, {}, { roomId: '!r:hs', userId: '@bob:hs' });
    await Promise.resolve(); // re-projection is coalesced into a microtask

    expect(svc.messages().find((m) => m.id === '$inv')?.summary).toBe(
      'Me invited Bob',
    );
  });

  it('renames a reaction’s named reactor when their member loads late', async () => {
    // The pill hint names reactors, whose profiles load lazily like any other member.
    // Without the reactor names in `eventRevision`'s reaction signature the cached view
    // is reused verbatim and the pill keeps naming a raw mxid forever.
    const events = [fakeEvent({ id: '$1', sender: '@me:hs', body: 'hi' })];
    let aliceLoaded = false;
    let memberHandler: ((...a: unknown[]) => void) | undefined;
    const relations = fakeRelations([['👍', new Set([fakeReaction('@a:hs')])]]);
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
        getState: () => undefined,
      }),
      findEventById: (id: string) => events.find((e) => e.getId() === id),
      getMember: (id: string) => {
        if (id === '@me:hs') {
          return { name: 'Me', getMxcAvatarUrl: () => null };
        }
        return aliceLoaded
          ? { name: 'Alice', getMxcAvatarUrl: () => null }
          : null;
      },
      relations: {
        getChildEventsForEvent: (id: string) =>
          id === '$1' ? relations : undefined,
      },
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

    expect(svc.messages()[0].reactions[0].reactors).toEqual(['@a:hs']);

    aliceLoaded = true;
    memberHandler?.({}, {}, { roomId: '!r:hs', userId: '@a:hs' });
    await Promise.resolve(); // re-projection is coalesced into a microtask

    expect(svc.messages()[0].reactions[0].reactors).toEqual(['Alice']);
  });

  it('reports every reactor per key on demand, and nothing for an unknown event', () => {
    const svc = setup(
      [fakeEvent({ id: '$1', sender: '@me:hs', body: 'hi' })],
      [],
      {
        $1: fakeRelations([
          ['👍', new Set([fakeReaction('@me:hs'), fakeReaction('@a:hs')])],
        ]),
      },
    );

    const [details] = svc.reactionDetails('$1');

    expect(details.key).toBe('👍');
    expect(details.reacted).toBe(true);
    // Uncapped and identified — this is what the who-reacted dialog lists.
    expect(details.reactors).toEqual([
      { userId: '@me:hs', name: 'Me', initial: 'M', avatarMxc: null },
      { userId: '@a:hs', name: 'Alice', initial: 'A', avatarMxc: null },
    ]);
    expect(svc.reactionDetails('$nope')).toEqual([]);
  });

  it('does not re-project when an unreferenced member changes', async () => {
    const events = [fakeEvent({ id: '$1', sender: '@a:hs', body: 'hi' })];
    let memberCalls = 0;
    let memberHandler: ((...a: unknown[]) => void) | undefined;
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
        getState: () => undefined,
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
    // Flush before asserting: re-projection is coalesced into a microtask, so asserting
    // synchronously here would pass even if a refresh HAD been wrongly scheduled.
    await Promise.resolve();
    expect(memberCalls).toBe(baseline);

    // A rendered sender → re-projects (reads members again).
    memberHandler?.({}, {}, { roomId: '!r:hs', userId: '@a:hs' });
    await Promise.resolve();
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
        getState: () => undefined,
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
        getState: () => undefined,
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

  it.each([
    { sendReceipts: true, expected: ReceiptType.Read, label: 'public' },
    {
      sendReceipts: false,
      expected: ReceiptType.ReadPrivate,
      label: 'private',
    },
  ])(
    'sends a $label read receipt when send-read-receipts is $sendReceipts',
    ({ sendReceipts, expected }) => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const received: { id: string; type: string }[] = [];
      const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
      const room = {
        roomId: '!r:hs',
        getLiveTimeline: () => ({
          getEvents: () => events,
          getPaginationToken: () => null,
          getState: () => undefined,
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
        sendReadReceipt: (e: { getId: () => string }, type: string) => {
          received.push({ id: e.getId(), type });
          return Promise.resolve({});
        },
        setRoomReadMarkers: () => Promise.resolve({}),
        scrollback: () => Promise.resolve(room),
      };
      TestBed.configureTestingModule({
        providers: [
          TimelineService,
          matrixProvider(client),
          privacyProvider(sendReceipts),
        ],
      });
      const svc = TestBed.inject(TimelineService);
      svc.open('!r:hs');

      expect(received).toEqual([{ id: '$a', type: expected }]);
    },
  );

  it('does not ack the open room while the window is unfocused (badge accrues)', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false); // app not in focus
    const received: { getId: () => string }[] = [];
    const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
        getState: () => undefined,
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
        getState: () => undefined,
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
        getState: () => undefined,
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
        getState: () => undefined,
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

  it('detaches client listeners from the account it opened on, not the active one', async () => {
    // `MatrixClientService.instance` follows the ACTIVE account. open() attaches its
    // client-level listeners (Decrypted/Typing/Crypto) to whichever client was active
    // then; if close() re-reads `instance` after an account switch it detaches from the
    // NEW client and leaks every listener on the old one — which is still syncing.
    const makeClient = () => {
      const handlers: Record<string, unknown[]> = {};
      return {
        baseUrl: 'https://hs',
        getRoom: () => room,
        getUserId: () => '@me:hs',
        on: (ev: string, h: unknown) => void (handlers[ev] ??= []).push(h),
        off: (ev: string, h: unknown) => {
          handlers[ev] = (handlers[ev] ?? []).filter((x) => x !== h);
        },
        sendReadReceipt: () => Promise.resolve({}),
        listenerCount: () =>
          Object.values(handlers).reduce((n, hs) => n + hs.length, 0),
      };
    };
    const room = fakeRoom([
      fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' }),
    ]);
    const clientA = makeClient();
    const clientB = makeClient();
    const active = { client: clientA as unknown };

    TestBed.configureTestingModule({
      providers: [TimelineService, switchableMatrixProvider(active)],
    });
    const svc = TestBed.inject(TimelineService);

    svc.open('!r:hs');
    expect(clientA.listenerCount()).toBeGreaterThan(0); // attached to A

    active.client = clientB; // the user switches accounts
    svc.close();

    expect(clientA.listenerCount()).toBe(0); // A's listeners must be gone
  });

  it('coalesces a burst of timeline events into a single re-projection', async () => {
    // matrix-js-sdk emits RoomEvent.Timeline once PER event, so paginating 30 messages
    // fires the handler 30 times. refresh() walks every loaded event (fingerprinting
    // each), so refreshing per event makes a burst quadratic. A burst must therefore
    // cost the same as one event — mirroring RoomsService.scheduleRefresh.
    let timelineHandler: (() => void) | undefined;
    let scans = 0;
    const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => {
          scans++;
          return events;
        },
        getPaginationToken: () => null,
        getState: () => undefined,
      }),
      findEventById: (id: string) => events.find((e) => e.getId() === id),
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
      sendReadReceipt: () => Promise.resolve({}),
    };
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client)],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');

    // Baseline: what one event costs, once the microtask has flushed.
    const before = scans;
    timelineHandler?.();
    await Promise.resolve();
    const costOfOne = scans - before;
    expect(costOfOne).toBeGreaterThan(0); // the handler really does re-project

    // A burst of five must cost exactly the same as one.
    const beforeBurst = scans;
    for (let i = 0; i < 5; i++) {
      timelineHandler?.();
    }
    await Promise.resolve();

    expect(scans - beforeBurst).toBe(costOfOne);
  });

  it('re-acks a live message in the open room, deduped across refreshes', async () => {
    const received: { getId: () => string }[] = [];
    const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
    let timelineHandler: (() => void) | undefined;
    const room = {
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
        getState: () => undefined,
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
    await Promise.resolve(); // re-projection is coalesced into a microtask
    expect(received.map((e) => e.getId())).toEqual(['$a', '$b']);

    // A refresh that doesn't change the latest (e.g. backfill) must not re-send.
    // Flush before asserting, or this would pass without the refresh even running.
    timelineHandler?.();
    await Promise.resolve();
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

    // A caption is a label for the attachment, not prose, so it is NOT linkified the way
    // a message body is — the two renderings share a code path and only diverge here, on
    // a plain caption that happens to contain a URL.
    it('leaves a plain MSC2530 caption unlinkified', () => {
      const svc = setup([
        fakeEvent({
          id: '$urlcap',
          sender: '@a:hs',
          msgtype: 'm.image',
          body: 'from https://example.com',
          filename: 'pic.png',
          url: 'mxc://hs/abc',
          info: { mimetype: 'image/png' },
        }),
      ]);

      const m = svc.messages()[0];
      expect(m.caption).toBe('from https://example.com');
      expect(m.captionHtml).toBeNull();
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

    it('flags an MSC3245 voice message and exposes its waveform', () => {
      const svc = setup([
        fakeEvent({
          id: '$voice',
          sender: '@a:hs',
          msgtype: 'm.audio',
          url: 'mxc://hs/clip',
          info: { mimetype: 'audio/webm', size: 10 },
          voice: true,
          waveform: [0, 512, 1024],
          durationMs: 3000,
        }),
      ]);

      const m = svc.messages()[0];
      expect(m.kind).toBe('audio');
      expect(m.media).toMatchObject({
        kind: 'audio',
        isVoice: true,
        waveform: [0, 512, 1024],
        durationMs: 3000,
      });
    });

    it('caps a hostile voice message’s waveform length (DoS guard)', () => {
      const svc = setup([
        fakeEvent({
          id: '$huge',
          sender: '@a:hs',
          msgtype: 'm.audio',
          url: 'mxc://hs/clip',
          info: { mimetype: 'audio/webm', size: 10 },
          voice: true,
          waveform: Array.from({ length: 5000 }, () => 512),
        }),
      ]);

      // Rendered one DOM node each, so the received array must be bounded.
      expect(svc.messages()[0].media?.waveform?.length).toBeLessThanOrEqual(
        512,
      );
    });

    it('leaves a plain m.audio unflagged as voice', () => {
      const svc = setup([
        fakeEvent({
          id: '$aud',
          sender: '@a:hs',
          msgtype: 'm.audio',
          url: 'mxc://hs/song',
          info: { mimetype: 'audio/mpeg', size: 100, duration: 60000 },
        }),
      ]);

      const media = svc.messages()[0].media;
      expect(media?.kind).toBe('audio');
      expect(media?.isVoice).toBeUndefined();
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

    it('uploads a recording and sends it as an MSC3245 voice message', async () => {
      const sent: unknown[][] = [];
      const svc = setup([], sent);

      await firstValueFrom(
        svc.sendVoiceMessage({
          blob: new Blob([new Uint8Array([1, 2, 3, 4])], {
            type: 'audio/webm',
          }),
          durationMs: 4200,
          waveform: [0, 512, 1024],
          mimeType: 'audio/webm',
        }),
      );

      expect(sent[0][0]).toBe('message');
      const content = sent[0][1] as Record<string, unknown>;
      expect(content['msgtype']).toBe('m.audio');
      expect(content['url']).toBe('mxc://hs/up');
      expect(content['org.matrix.msc3245.voice']).toEqual({});
      expect(content['org.matrix.msc1767.audio']).toEqual({
        duration: 4200,
        waveform: [0, 512, 1024],
      });
    });

    it('is a no-op for an empty recording', async () => {
      const sent: unknown[][] = [];
      const svc = setup([], sent);

      await firstValueFrom(
        svc.sendVoiceMessage({
          blob: new Blob([]),
          durationMs: 0,
          waveform: [],
          mimeType: 'audio/webm',
        }),
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

    const joinEvent = () =>
      fakeEvent({
        id: '$e',
        sender: '@alice:hs',
        type: 'm.room.member',
        stateKey: '@bob:hs',
        content: { membership: 'join' },
      });

    it('anchors on the next message, skipping a system line after the marker', () => {
      const { svc } = setupUnread(
        [
          fakeEvent({ id: '$1', sender: '@alice:hs', body: 'a' }),
          joinEvent(),
          fakeEvent({ id: '$3', sender: '@alice:hs', body: 'theirs' }),
        ],
        '$1',
      );
      expect(svc.firstUnreadId()).toBe('$3');
    });

    it('is null when only system (membership) churn followed the marker', () => {
      const { svc } = setupUnread(
        [fakeEvent({ id: '$1', sender: '@alice:hs', body: 'a' }), joinEvent()],
        '$1',
      );
      expect(svc.firstUnreadId()).toBeNull();
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

    it("refreshes a receipt avatar when the reader's member loads late", async () => {
      // A reader who has posted nothing in the window is nobody's sender, reply target
      // or reactor. Both defences used to miss them: the revision folded in receipt
      // *ids* only, so an avatar-only change produced an identical fingerprint, and the
      // member-listener gate never had them in `relevantSenders` to begin with.
      const events = [fakeEvent({ id: '$1', sender: '@a:hs', body: 'hello' })];
      let readerLoaded = false;
      let memberHandler: ((...a: unknown[]) => void) | undefined;
      const room = {
        roomId: '!r:hs',
        getLiveTimeline: () => ({
          getEvents: () => events,
          getPaginationToken: () => null,
          getState: () => undefined,
        }),
        findEventById: (id: string) => events.find((e) => e.getId() === id),
        getMember: (id: string) => {
          if (id === '@reader:hs') {
            return readerLoaded
              ? { name: 'Reader', getMxcAvatarUrl: () => 'mxc://hs/reader' }
              : null;
          }
          return { name: 'A', getMxcAvatarUrl: () => null };
        },
        getUsersReadUpTo: () => ['@reader:hs'],
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

      // Not in room state yet: the receipt shows the raw mxid and no avatar.
      expect(svc.messages()[0].readReceipts[0]).toMatchObject({
        name: '@reader:hs',
        avatarMxc: null,
      });

      readerLoaded = true;
      memberHandler?.({}, {}, { roomId: '!r:hs', userId: '@reader:hs' });
      await Promise.resolve(); // re-projection is coalesced into a microtask

      expect(svc.messages()[0].readReceipts[0]).toMatchObject({
        name: 'Reader',
        avatarMxc: 'mxc://hs/reader',
      });
    });
  });

  describe('linkify', () => {
    it('linkifies a bare URL in a plain-text message so it renders clickable', () => {
      const svc = setup([
        fakeEvent({
          id: '$1',
          sender: '@a:hs',
          body: 'see https://example.com',
        }),
      ]);
      expect(svc.messages()[0].html).toContain(
        '<a href="https://example.com">https://example.com</a>',
      );
    });

    it('leaves a plain message without a URL as plain text (no html)', () => {
      const svc = setup([
        fakeEvent({ id: '$1', sender: '@a:hs', body: 'no links here' }),
      ]);
      expect(svc.messages()[0].html).toBeNull();
    });
  });

  describe('link preview url', () => {
    function urlRoomClient(encrypted: boolean) {
      const events = [
        fakeEvent({
          id: '$1',
          sender: '@a:hs',
          body: 'see https://example.com',
        }),
      ];
      const room = {
        roomId: '!r:hs',
        getLiveTimeline: () => ({
          getEvents: () => events,
          getPaginationToken: () => null,
          getState: () => undefined,
        }),
        getMember: () => ({ name: 'A', getMxcAvatarUrl: () => null }),
        relations: { getChildEventsForEvent: () => undefined },
        hasEncryptionStateEvent: () => encrypted,
        on: () => {},
        off: () => {},
      };
      return {
        baseUrl: 'https://hs',
        getRoom: () => room,
        getUserId: () => '@me:hs',
        on: () => {},
        off: () => {},
        sendReadReceipt: () => Promise.resolve({}),
        setRoomReadMarkers: () => Promise.resolve({}),
        scrollback: () => Promise.resolve(room),
      };
    }

    function openUrlRoom(encrypted: boolean) {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      TestBed.configureTestingModule({
        providers: [TimelineService, matrixProvider(urlRoomClient(encrypted))],
      });
      const svc = TestBed.inject(TimelineService);
      svc.open('!r:hs');
      return svc;
    }

    it('sets previewUrl and marks the message unencrypted in a plaintext room', () => {
      const message = openUrlRoom(false).messages()[0];
      expect(message.previewUrl).toBe('https://example.com');
      expect(message.previewEncrypted).toBe(false);
    });

    it('sets previewUrl but marks the message encrypted in an E2EE room', () => {
      // The URL is still surfaced; `previewEncrypted` gates whether it's actually
      // previewed (the component needs the encrypted-rooms opt-in).
      const message = openUrlRoom(true).messages()[0];
      expect(message.previewUrl).toBe('https://example.com');
      expect(message.previewEncrypted).toBe(true);
    });
  });

  describe('tombstone', () => {
    function tombstoneClient(replacement: string | null) {
      const events = [fakeEvent({ id: '$1', sender: '@a:hs', body: 'hi' })];
      const room = {
        roomId: '!r:hs',
        // Room state hangs off the live timeline (what liveRoomState() reads, and what
        // the SDK's deprecated `currentState` aliased).
        getLiveTimeline: () => ({
          getEvents: () => events,
          getPaginationToken: () => null,
          getState: () => ({
            getStateEvents: (type: string) =>
              type === 'm.room.tombstone' && replacement
                ? {
                    getContent: () => ({
                      replacement_room: replacement,
                      body: 'upgraded',
                    }),
                  }
                : null,
          }),
        }),
        getMember: () => ({ name: 'A', getMxcAvatarUrl: () => null }),
        relations: { getChildEventsForEvent: () => undefined },
        on: () => {},
        off: () => {},
      };
      return {
        baseUrl: 'https://hs',
        getRoom: () => room,
        getUserId: () => '@me:hs',
        on: () => {},
        off: () => {},
        sendReadReceipt: () => Promise.resolve({}),
        setRoomReadMarkers: () => Promise.resolve({}),
        scrollback: () => Promise.resolve(room),
      };
    }

    function openTombstoneRoom(replacement: string | null) {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      TestBed.configureTestingModule({
        providers: [
          TimelineService,
          matrixProvider(tombstoneClient(replacement)),
        ],
      });
      const svc = TestBed.inject(TimelineService);
      svc.open('!r:hs');
      return svc;
    }

    it('exposes the successor room when the room is tombstoned', () => {
      expect(openTombstoneRoom('!new:hs').tombstone()).toEqual({
        replacementRoomId: '!new:hs',
        body: 'upgraded',
      });
    });

    it('is null for a live (non-tombstoned) room', () => {
      expect(openTombstoneRoom(null).tombstone()).toBeNull();
    });
  });

  // Which edit a message resolves to can change with no new event arriving: redacting an
  // edit re-aggregates the message onto an earlier revision. That is a different signal
  // from RoomEvent.Timeline — nothing was added or removed — so without a listener for it
  // the row keeps rendering the version that just went away.
  describe('re-aggregation after an edit is redacted', () => {
    function openWithEvent(opts: Parameters<typeof fakeEvent>[0]) {
      const event = fakeEvent(opts);
      const room = fakeRoom([event]);
      const client = fakeClient(room, []);
      TestBed.configureTestingModule({
        providers: [TimelineService, matrixProvider(client), mediaProvider()],
      });
      const svc = TestBed.inject(TimelineService);
      svc.open('!r:hs');
      return { svc, client, event };
    }

    it('re-projects the message when it resolves to a different edit', async () => {
      const opts = {
        id: '$a',
        sender: '@a:hs',
        body: 'newest wording',
        edited: true,
      };
      const { svc, client, event } = openWithEvent(opts);
      expect(svc.messages()[0].body).toBe('newest wording');
      expect(svc.messages()[0].edited).toBe(true);

      // What the SDK does after the newest edit is redacted: the same event now reads as
      // an earlier version, and it emits Replaced rather than a timeline change.
      opts.body = 'earlier wording';
      opts.edited = false;
      client.handlers.get('Event.replaced')?.(event);

      await vi.waitFor(() =>
        expect(svc.messages()[0].body).toBe('earlier wording'),
      );
      // The marker follows too — it is the only way into the edit history.
      expect(svc.messages()[0].edited).toBe(false);
    });

    it('ignores a replacement in a room it is not showing', async () => {
      const opts = { id: '$a', sender: '@a:hs', body: 'unchanged' };
      const { svc, client } = openWithEvent(opts);

      opts.body = 'should not appear';
      client.handlers.get('Event.replaced')?.({
        getRoomId: () => '!other:hs',
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(svc.messages()[0].body).toBe('unchanged');
    });
  });

  describe('per-message authenticity shields', () => {
    function shieldClient(
      events: ReturnType<typeof fakeEvent>[],
      getEncryptionInfoForEvent: Mock,
    ) {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const room = {
        roomId: '!r:hs',
        getLiveTimeline: () => ({
          getEvents: () => events,
          getPaginationToken: () => null,
          getState: () => undefined,
        }),
        getMember: () => ({ name: 'A', getMxcAvatarUrl: () => null }),
        relations: { getChildEventsForEvent: () => undefined },
        on: (event: string, handler: (...a: unknown[]) => void) => {
          handlers.set(`room:${event}`, handler);
        },
        off: () => {},
      };
      return {
        baseUrl: 'https://hs',
        handlers,
        getRoom: () => room,
        getUserId: () => '@me:hs',
        on: (event: string, handler: (...a: unknown[]) => void) => {
          handlers.set(`client:${event}`, handler);
        },
        off: () => {},
        sendReadReceipt: () => Promise.resolve({}),
        setRoomReadMarkers: () => Promise.resolve({}),
        getCrypto: () => ({ getEncryptionInfoForEvent }),
        scrollback: () => Promise.resolve(room),
      };
    }

    function openWithShield(getEncryptionInfoForEvent: Mock, encrypted = true) {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const events = [
        fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi', encrypted }),
      ];
      const client = shieldClient(events, getEncryptionInfoForEvent);
      TestBed.configureTestingModule({
        providers: [TimelineService, matrixProvider(client)],
      });
      const svc = TestBed.inject(TimelineService);
      svc.open('!r:hs');
      return { svc, handlers: client.handlers };
    }

    it('projects a grey shield for an unverified-device message', async () => {
      const getInfo = vi.fn().mockResolvedValue({
        shieldColour: EventShieldColour.GREY,
        shieldReason: EventShieldReason.UNSIGNED_DEVICE,
      });
      const { svc } = openWithShield(getInfo);

      await vi.waitFor(() =>
        expect(svc.messages()[0].shield).toEqual({
          level: 'grey',
          reason: expect.any(String),
          explanation: expect.any(String),
        }),
      );
    });

    it('projects a red shield for a red colour', async () => {
      const getInfo = vi.fn().mockResolvedValue({
        shieldColour: EventShieldColour.RED,
        shieldReason: EventShieldReason.UNVERIFIED_IDENTITY,
      });
      const { svc } = openWithShield(getInfo);

      await vi.waitFor(() =>
        expect(svc.messages()[0].shield?.level).toBe('red'),
      );
    });

    it('leaves an unencrypted message without a shield (no crypto probe)', async () => {
      const getInfo = vi.fn();
      const { svc } = openWithShield(getInfo, false);

      await Promise.resolve();
      expect(svc.messages()[0].shield ?? null).toBeNull();
      expect(getInfo).not.toHaveBeenCalled();
    });

    it('shows no shield when the colour resolves to NONE', async () => {
      const getInfo = vi
        .fn()
        .mockResolvedValue({ shieldColour: EventShieldColour.NONE });
      const { svc } = openWithShield(getInfo);

      await vi.waitFor(() => expect(getInfo).toHaveBeenCalled());
      expect(svc.messages()[0].shield ?? null).toBeNull();
    });

    it('does not re-probe a resolved event on a benign refresh, but does on a trust change', async () => {
      const getInfo = vi.fn().mockResolvedValue({
        shieldColour: EventShieldColour.GREY,
        shieldReason: EventShieldReason.UNSIGNED_DEVICE,
      });
      const { svc, handlers } = openWithShield(getInfo);

      await vi.waitFor(() =>
        expect(svc.messages()[0].shield?.level).toBe('grey'),
      );
      const afterOpen = getInfo.mock.calls.length;

      // A receipt triggers a refresh, but the event is already resolved (and not a
      // decryption failure) — no extra crypto probe.
      handlers.get('room:Room.receipt')?.();
      await Promise.resolve();
      expect(getInfo.mock.calls.length).toBe(afterOpen);

      // A trust change forces a full re-resolve.
      handlers.get('client:userTrustStatusChanged')?.();
      await vi.waitFor(() =>
        expect(getInfo.mock.calls.length).toBeGreaterThan(afterOpen),
      );
    });
  });
});

// Issue #21: system lines can be hidden per category from Settings → Appearance. The filter
// runs in the projection, so a hidden line leaves no row at all.
describe('TimelineService system-line filtering', () => {
  /** join, a display-name change, a topic change, and two real messages around them. */
  const churn = () => [
    fakeEvent({ id: '$1', sender: '@alice:hs', body: 'first' }),
    fakeEvent({
      id: '$join',
      sender: '@bob:hs',
      type: 'm.room.member',
      stateKey: '@bob:hs',
      content: { membership: 'join' },
    }),
    fakeEvent({
      id: '$rename',
      sender: '@bob:hs',
      type: 'm.room.member',
      stateKey: '@bob:hs',
      content: { membership: 'join', displayname: 'Bobby' },
      prevContent: { membership: 'join', displayname: 'Bob' },
    }),
    fakeEvent({
      id: '$topic',
      sender: '@mod:hs',
      type: 'm.room.topic',
      stateKey: '',
      content: { topic: 'new topic' },
    }),
    fakeEvent({ id: '$2', sender: '@alice:hs', body: 'second' }),
  ];

  function setupFiltered(shown: Parameters<typeof systemLinesProvider>[0]) {
    const lines = systemLinesProvider(shown);
    const room = fakeRoom(churn(), {}, false, [], null);
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        matrixProvider(fakeClient(room, [])),
        mediaProvider(),
        lines.provider,
      ],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');
    return { svc, lines };
  }

  it('shows every category by default', () => {
    const { svc } = setupFiltered({});
    expect(svc.messages().map((m) => m.id)).toEqual([
      '$1',
      '$join',
      '$rename',
      '$topic',
      '$2',
    ]);
  });

  // Membership and profile are both m.room.member events, so hiding one must not take the
  // other with it — that is the whole point of the granularity.
  it('hides membership lines without hiding profile changes', () => {
    const { svc } = setupFiltered({ membership: false });
    expect(svc.messages().map((m) => m.id)).toEqual([
      '$1',
      '$rename',
      '$topic',
      '$2',
    ]);
  });

  it('hides profile changes without hiding joins', () => {
    const { svc } = setupFiltered({ profile: false });
    expect(svc.messages().map((m) => m.id)).toEqual([
      '$1',
      '$join',
      '$topic',
      '$2',
    ]);
  });

  it('hides room-state changes on their own', () => {
    const { svc } = setupFiltered({ room: false });
    expect(svc.messages().map((m) => m.id)).toEqual([
      '$1',
      '$join',
      '$rename',
      '$2',
    ]);
  });

  it('leaves only real messages when every category is off', () => {
    const { svc } = setupFiltered({
      membership: false,
      profile: false,
      room: false,
    });
    expect(svc.messages().map((m) => m.id)).toEqual(['$1', '$2']);
  });

  it('re-projects the open room when a category is toggled', async () => {
    const { svc, lines } = setupFiltered({});
    expect(svc.messages().map((m) => m.id)).toContain('$join');

    // The effect schedules the refresh onto a microtask (coalescing bursts), so the
    // assertion has to wait for that flush — not just the effect run.
    const flush = async () => {
      TestBed.tick();
      await Promise.resolve();
      await Promise.resolve();
    };
    // Let the effect take its baseline read first: its very first run is the initial read of
    // the preferences, not a change, so it deliberately doesn't re-project.
    await flush();

    lines.membership.set(false);
    await flush();
    expect(svc.messages().map((m) => m.id)).not.toContain('$join');

    lines.membership.set(true);
    await flush();
    expect(svc.messages().map((m) => m.id)).toContain('$join');
  });

  // The oldest RAW event drives the lists' backfill loop: the oldest RENDERED row can't,
  // because a page of purely-hidden lines would leave it unchanged and the loop would stop
  // with history still to load (or never start, for an all-hidden window).
  it('reports the oldest raw event even when every row is filtered out', async () => {
    const lines = systemLinesProvider({ membership: false, profile: false });
    const onlyChurn = [
      fakeEvent({
        id: '$join',
        sender: '@bob:hs',
        type: 'm.room.member',
        stateKey: '@bob:hs',
        content: { membership: 'join' },
      }),
      fakeEvent({
        id: '$rename',
        sender: '@bob:hs',
        type: 'm.room.member',
        stateKey: '@bob:hs',
        content: { membership: 'join', displayname: 'Bobby' },
        prevContent: { membership: 'join', displayname: 'Bob' },
      }),
    ];
    const room = fakeRoom(onlyChurn, {}, false, [], null);
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        matrixProvider(fakeClient(room, [])),
        mediaProvider(),
        lines.provider,
      ],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');

    expect(svc.messages()).toEqual([]); // nothing survives the filter…
    expect(svc.oldestEventId()).toBe('$join'); // …but history is still paginable
  });

  // markRead acks the newest RAW timeline event, so m.fully_read can point at an event the
  // projection never renders — a hidden membership line, but equally a reaction or an edit.
  // Resolving the divider from the projected list would find nothing and drop it silently.
  it('still anchors the unread divider when the read marker is a hidden line', () => {
    const lines = systemLinesProvider({ membership: false });
    const room = fakeRoom(churn(), {}, false, [], '$join');
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        matrixProvider(fakeClient(room, [])),
        mediaProvider(),
        lines.provider,
      ],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');

    expect(svc.messages().map((m) => m.id)).not.toContain('$join');
    // '$rename' is a system line and '$2' is the next real message from someone else.
    expect(svc.firstUnreadId()).toBe('$2');
  });

  // The same hole for an event the projection drops for reasons unrelated to this feature:
  // markRead acks reactions and edits too, so the marker can name one of those.
  it('still anchors the divider when the read marker is a reaction', () => {
    const events = [
      fakeEvent({ id: '$1', sender: '@alice:hs', body: 'a' }),
      fakeEvent({
        id: '$react',
        sender: '@me:hs',
        type: 'm.reaction',
        relatesTo: { rel_type: 'm.annotation', event_id: '$1', key: '👍' },
      }),
      fakeEvent({ id: '$2', sender: '@alice:hs', body: 'b' }),
    ];
    const room = fakeRoom(events, {}, false, [], '$react');
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        matrixProvider(fakeClient(room, [])),
        mediaProvider(),
      ],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');

    // The reaction is never rendered, but it still positions the divider.
    expect(svc.messages().map((m) => m.id)).toEqual(['$1', '$2']);
    expect(svc.firstUnreadId()).toBe('$2');
  });
});

/**
 * Jump to date. The interesting half is not `timestampToEvent` — it is that the server
 * answers for the whole room and happily names an event this client has never loaded, so
 * scrolling to it would silently do nothing without the bounded backfill.
 */
describe('TimelineService.jumpToDate', () => {
  /**
   * A room whose live timeline starts with `loaded` events and grows by `pageSize` each
   * time `scrollback` is called, until `total` events exist. `target` is only findable
   * once it has actually been paged in — which is what makes the loop observable.
   */
  function pagingSetup(opts: {
    loaded: number;
    total: number;
    targetIndex: number;
    timestampToEvent?: () => Promise<{ event_id: string }>;
    pageSize?: number;
  }) {
    const pageSize = opts.pageSize ?? 30;
    // Increasing timestamps: event i sits at (i + 1) * 1000, so a "day start" of
    // (targetIndex + 1) * 1000 selects exactly that event and everything after it.
    const all = Array.from({ length: opts.total }, (_, i) =>
      fakeEvent({
        id: `$e${i}`,
        sender: '@alice:hs',
        body: `m${i}`,
        ts: (i + 1) * 1000,
      }),
    );
    // The live timeline holds the NEWEST `loaded` events; scrollback prepends older ones.
    let shown = all.slice(opts.total - opts.loaded);
    const room = {
      ...fakeRoom([]),
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => shown,
        getPaginationToken: () => 'tok',
        getState: () => ({ hasSufficientPowerLevelFor: () => false }),
      }),
      findEventById: (id: string) => shown.find((e) => e.getId() === id),
    };
    let scrollbacks = 0;
    const asked: { roomId: string; timestamp: number; dir: Direction }[] = [];
    const client = {
      ...fakeClient(room as never, []),
      getRoom: () => room,
      scrollback: () => {
        scrollbacks++;
        const next = Math.min(shown.length + pageSize, all.length);
        shown = all.slice(all.length - next);
        return Promise.resolve(room);
      },
      timestampToEvent: (roomId: string, timestamp: number, dir: Direction) => {
        asked.push({ roomId, timestamp, dir });
        return (
          opts.timestampToEvent?.() ??
          Promise.resolve({ event_id: `$e${opts.targetIndex}` })
        );
      },
    };
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client), mediaProvider()],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');
    return { svc, scrollbacks: () => scrollbacks, asked };
  }

  it('returns the event straight away when it is already loaded', async () => {
    const { svc, scrollbacks } = pagingSetup({
      loaded: 50,
      total: 50,
      targetIndex: 40,
    });

    const result = await firstValueFrom(svc.jumpToDate(41_000));

    expect(result).toEqual({ kind: 'found', eventId: '$e40' });
    // No paging at all: the common case (a recent date) must not cost a round trip.
    expect(scrollbacks()).toBe(0);
  });

  it('pages history back until the target is loaded', async () => {
    const { svc, scrollbacks } = pagingSetup({
      loaded: 10,
      total: 100,
      targetIndex: 5, // 95 events older than the loaded window
    });

    const result = await firstValueFrom(svc.jumpToDate(6_000));

    expect(result).toEqual({ kind: 'found', eventId: '$e5' });
    // Without the loop this is where "jump to date" silently does nothing: the id is
    // real, the DOM has never seen it, and scrollIntoView finds no element.
    expect(scrollbacks()).toBeGreaterThan(0);
  });

  it('asks for the first event AFTER midnight, not the last one before it', async () => {
    const { svc, asked } = pagingSetup({
      loaded: 50,
      total: 50,
      targetIndex: 40,
    });
    const midnight = 1_700_000_000_000;

    await firstValueFrom(svc.jumpToDate(midnight));

    // Direction decides which day you land on. Backward returns the last event BEFORE the
    // timestamp — i.e. the tail of the previous day — for any date whose own messages all
    // sit later than midnight, which is every date.
    expect(asked).toEqual([
      { roomId: '!r:hs', timestamp: midnight, dir: Direction.Forward },
    ]);
  });

  it('gives up rather than paging a huge room to its start', async () => {
    // 20 pages x 30 = 600; the target sits beyond that.
    const { svc, scrollbacks } = pagingSetup({
      loaded: 10,
      total: 5000,
      targetIndex: 0,
    });

    const result = await firstValueFrom(svc.jumpToDate(1_000));

    expect(result).toEqual({ kind: 'too-far' });
    expect(scrollbacks()).toBe(20);
  });

  it('stops early when the room has no more history', async () => {
    // The target id is not in the room at all, and the room is shorter than the bound —
    // without the "did the timeline actually grow?" check this burns all 20 pages on
    // requests that return nothing.
    const { svc, scrollbacks } = pagingSetup({
      loaded: 10,
      total: 40,
      targetIndex: 0,
      timestampToEvent: () => Promise.resolve({ event_id: '$missing' }),
    });

    const result = await firstValueFrom(svc.jumpToDate(1000));

    expect(result).toEqual({ kind: 'too-far' });
    expect(scrollbacks()).toBeLessThan(20);
  });

  it('reports a server that does not implement the endpoint', async () => {
    const { svc } = pagingSetup({
      loaded: 10,
      total: 10,
      targetIndex: 0,
      timestampToEvent: () =>
        Promise.reject(
          Object.assign(new Error('nope'), {
            errcode: 'M_UNRECOGNIZED',
          }),
        ),
    });

    // Distinguished from "no event": there is nothing the user can do about this one, and
    // telling them the date is empty would be a lie.
    expect(await firstValueFrom(svc.jumpToDate(1000))).toEqual({
      kind: 'unsupported',
    });
  });

  it('does not call a network failure "no messages that day"', async () => {
    const { svc } = pagingSetup({
      loaded: 10,
      total: 10,
      targetIndex: 0,
      timestampToEvent: () => Promise.reject(new Error('offline')),
    });

    // A ConnectionError carries no errcode. Saying "no messages on or after that date"
    // here tells someone on a captive portal that a day they spent chatting was empty —
    // a claim about the room, made from a failure to ask.
    expect(await firstValueFrom(svc.jumpToDate(1000))).toEqual({
      kind: 'failed',
    });
  });

  it('does not call a rate limit "no messages that day" either', async () => {
    // Plausible precisely because of this feature: up to 20 scrollbacks in a burst.
    const { svc } = pagingSetup({
      loaded: 10,
      total: 10,
      targetIndex: 0,
      timestampToEvent: () =>
        Promise.reject(
          Object.assign(new Error('slow down'), {
            errcode: 'M_LIMIT_EXCEEDED',
          }),
        ),
    });

    expect(await firstValueFrom(svc.jumpToDate(1000))).toEqual({
      kind: 'failed',
    });
  });

  it('stops paginating when the user leaves the room mid-backfill', async () => {
    const { svc, scrollbacks } = pagingSetup({
      loaded: 10,
      total: 5000,
      targetIndex: 0,
    });

    const result = firstValueFrom(svc.jumpToDate(1000));
    svc.close(); // the user clicks another room while the loop is in flight

    expect(await result).toEqual({ kind: 'too-far' });
    // It must not keep paging a room nobody is looking at, and it must not leave the flag
    // set — the next room's viewport-fill loop bails while it is true.
    expect(scrollbacks()).toBeLessThan(20);
    expect(svc.loadingOlder()).toBe(false);
  });

  it('reports a date the room has nothing at or after', async () => {
    const { svc } = pagingSetup({
      loaded: 10,
      total: 10,
      targetIndex: 0,
      timestampToEvent: () =>
        Promise.reject(
          Object.assign(new Error('none'), {
            errcode: 'M_NOT_FOUND',
          }),
        ),
    });

    expect(await firstValueFrom(svc.jumpToDate(1000))).toEqual({
      kind: 'no-event',
    });
  });

  it('does not claim success for an event the timeline will never render', async () => {
    // `findEventById` answers for the RAW event, but the projection only keeps
    // m.room.message (and displayable state). If the first event on the chosen day is a
    // reaction, an edit, or a hidden system line, the raw id is findable and the message
    // list has nothing carrying it — so reporting `found` produces a jump to an id that is
    // not in `messages()`: the dialog closes, nothing scrolls, and no toast explains why.
    const reaction = fakeEvent({ id: '$react', sender: '@alice:hs', body: '' });
    reaction.getType = () => 'm.reaction';
    const shown = [
      reaction,
      fakeEvent({
        id: '$real',
        sender: '@alice:hs',
        body: 'the actual message',
      }),
    ];
    const room = {
      ...fakeRoom([]),
      roomId: '!r:hs',
      getLiveTimeline: () => ({
        getEvents: () => shown,
        getPaginationToken: () => null,
        getState: () => ({ hasSufficientPowerLevelFor: () => false }),
      }),
      findEventById: (id: string) => shown.find((e) => e.getId() === id),
    };
    const client = {
      ...fakeClient(room as never, []),
      getRoom: () => room,
      scrollback: () => Promise.resolve(room),
      timestampToEvent: () => Promise.resolve({ event_id: '$react' }),
    };
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client), mediaProvider()],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');

    const result = await firstValueFrom(svc.jumpToDate(0));

    // Whatever it answers, it must name something the list can actually scroll to.
    if (result.kind === 'found') {
      expect(svc.messages().map((m) => m.id)).toContain(result.eventId);
    }
  });

  it('clears the loading flag whether it succeeds or fails', async () => {
    const { svc } = pagingSetup({ loaded: 10, total: 100, targetIndex: 5 });

    await firstValueFrom(svc.jumpToDate(1000));

    // Shared with loadOlder: a stuck flag disables pagination for the room's lifetime.
    expect(svc.loadingOlder()).toBe(false);
  });
});
