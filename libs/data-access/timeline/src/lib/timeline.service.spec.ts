import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import {
  ConnectionError,
  MatrixError,
  ReceiptType,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { TimelineService } from './timeline.service';
import { eventRevision } from './js-sdk/event-revision';
import {
  clientFor,
  fakeClient,
  EDITED_MARK,
  fakeEdit,
  fakeEvent,
  fakeReaction,
  fakeRelations,
  fakeRoom,
  matrixProvider,
  mediaProvider,
  openTimeline,
  privacyProvider,
  setup,
  switchableMatrixProvider,
} from './timeline.spec-harness';
import { resolvedShields } from './js-sdk/shields';

// The fake clients here model one page of history as `client.scrollback`. The real paging
// (and its race with gappy syncs) is covered against the SDK in live-scrollback.spec.
vi.mock('./js-sdk/live-scrollback', () => ({
  scrollbackLive: async (
    client: { scrollback: (room: unknown, limit: number) => Promise<unknown> },
    room: unknown,
    limit: number,
  ) => {
    await client.scrollback(room, limit);
  },
}));

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [privacyProvider(true)] });
});

describe('TimelineService', () => {
  beforeEach(() => {
    // Viewing a room = the window is focused (the normal case). markRead only acks
    // while focused; the unfocused / refocus paths are exercised explicitly below.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('loads the full member list of the room it opens (#1295)', () => {
    const loadMembersIfNeeded = vi.fn(() => Promise.resolve(true));
    const room = {
      ...fakeRoom([]),
      getMember: () => null,
      loadMembersIfNeeded,
    };
    const client = clientFor(room);
    openTimeline(client);

    // A lazily synced room knows only the senders it has seen: mentions, typing names and
    // the member list need everyone once the room is in use.
    expect(loadMembersIfNeeded).toHaveBeenCalledOnce();
  });

  it('reports ready and ignores retry without a readiness owner', () => {
    const svc = setup([]);
    expect(svc.loadState()).toEqual({ kind: 'ready' });
    expect(() => svc.retryLoad()).not.toThrow();
  });

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

    // The remote image reduces to its alt text (no element, so no empty box and no fetch); the
    // mxc source moves off src for the render leaf to resolve through authenticated media.
    expect(svc.messages()[0].html).toBe(
      'leak<img alt="ok" data-mx-src="mxc://hs/abc" class="mx-image" role="button" ' +
        'tabindex="0" aria-label="View image: ok"><strong>text</strong>',
    );
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

  it('neutralizes javascript: links and ignores a sender’s target', () => {
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
    const [neutralised, safe] = Array.from(
      new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a'),
    );
    // The sender's target never survives; only the render pass marks safe http(s) links.
    expect(neutralised.hasAttribute('target')).toBe(false);
    expect(safe.getAttribute('href')).toBe('https://ok.test/');
    expect(safe.getAttribute('target')).toBe('_blank');
    expect(safe.getAttribute('rel')).toBe('noopener noreferrer');
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

  it('canSendMessages updates when power levels change', async () => {
    const power = { mine: 0, send: 0 };
    const svc = setup([], [], {}, false, power);
    expect(svc.canSendMessages()).toBe(true);

    power.send = 50;
    const room = TestBed.inject(MatrixClientService).instance as unknown as {
      getRoom: () => { handlers: Map<string, (event: unknown) => void> };
    };
    room.getRoom().handlers.get(RoomStateEvent.Events)?.({
      getRoomId: () => '!r:hs',
      getType: () => 'm.room.power_levels',
    });
    await Promise.resolve();
    expect(svc.canSendMessages()).toBe(false);
  });

  it('canSendMessages follows a change to only my own level once the SDK applies it', async () => {
    const power = { mine: 0, send: 50, redact: 50 };
    const svc = setup([], [], {}, false, power);
    expect(svc.canSendMessages()).toBe(false);

    const room = TestBed.inject(MatrixClientService).instance as unknown as {
      getRoom: () => { handlers: Map<string, (event: unknown) => void> };
    };
    // matrix-js-sdk emits RoomState.events before it updates member.powerLevel.
    room.getRoom().handlers.get(RoomStateEvent.Events)?.({
      getRoomId: () => '!r:hs',
      getType: () => 'm.room.power_levels',
    });
    power.mine = 50;
    await Promise.resolve();

    expect(svc.canSendMessages()).toBe(true);
    expect(svc.canRedactOthers()).toBe(true);
  });

  it('canSendMessages resets to true when the room closes', () => {
    const svc = setup([], [], {}, false, { mine: 0, send: 50 });
    expect(svc.canSendMessages()).toBe(false);

    svc.close();
    expect(svc.canSendMessages()).toBe(true);
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
      shield: null,
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
      ...fakeRoom(events),
      getMember: (id: string) => {
        if (id === '@me:hs') {
          return { name: 'Me', getMxcAvatarUrl: () => null };
        }
        return aliceLoaded
          ? { name: 'Alice', getMxcAvatarUrl: () => 'mxc://hs/av' }
          : null;
      },
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        if (ev === RoomStateEvent.Members) {
          memberHandler = cb;
        }
      },
    };
    const client = clientFor(room);
    const svc = openTimeline(client);

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

  it('renames a mention pill when the member loads late and when they rename', async () => {
    const events = [
      fakeEvent({
        id: '$m',
        sender: '@me:hs',
        body: 'hi',
        format: 'org.matrix.custom.html',
        formattedBody: 'hi <a href="https://matrix.to/#/@a:hs">@Boss</a>',
      }),
    ];
    let aliceName: string | null = null;
    let memberHandler: ((...a: unknown[]) => void) | undefined;
    const room = {
      roomId: '!r:hs',
      loadMembersIfNeeded: () => Promise.resolve(true),
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
        getState: () => undefined,
      }),
      findEventById: (id: string) => events.find((e) => e.getId() === id),
      getMember: (id: string) =>
        id === '@me:hs'
          ? { name: 'Me', getMxcAvatarUrl: () => null }
          : aliceName
            ? { name: aliceName, getMxcAvatarUrl: () => null }
            : null,
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
    const pill = () => svc.messages().find((m) => m.id === '$m')?.html;

    expect(pill()).toContain('>@a:hs</a>');

    aliceName = 'Alice';
    memberHandler?.({}, {}, { roomId: '!r:hs', userId: '@a:hs' });
    await Promise.resolve();
    expect(pill()).toContain('>@Alice</a>');

    aliceName = 'Alicia';
    memberHandler?.({}, {}, { roomId: '!r:hs', userId: '@a:hs' });
    await Promise.resolve();
    expect(pill()).toContain('>@Alicia</a>');
  });

  it('re-renders a row whose offline failure turns into a refusal', () => {
    const echo = {
      ...fakeEvent({ id: '$m', sender: '@me:hs', status: 'not_sent' }),
      error: new ConnectionError('offline') as unknown,
    };
    const revision = () =>
      eventRevision(
        fakeClient(fakeRoom([echo]), []) as unknown as MatrixClient,
        fakeRoom([echo]) as unknown as Room,
        echo as unknown as MatrixEvent,
        false,
      );

    const waiting = revision();
    echo.error = new MatrixError({ errcode: 'M_FORBIDDEN' }, 403);

    expect(revision()).not.toBe(waiting);
  });

  it('keys mention pills to the shown content, not an edit by someone else', () => {
    const link = (id: string) =>
      `hi <a href="https://matrix.to/#/${id}">@x</a>`;
    const forgedContent = () => ({
      'm.new_content': {
        body: 'hi',
        msgtype: 'm.text',
        format: 'org.matrix.custom.html',
        formatted_body: link('@b:hs'),
      },
    });
    const forged = {
      ...fakeEdit('$m'),
      getSender: () => '@mallory:hs',
      getContent: forgedContent,
      getOriginalContent: forgedContent,
    };
    const event = fakeEvent({
      id: '$m',
      sender: '@me:hs',
      body: 'hi',
      format: 'org.matrix.custom.html',
      formattedBody: link('@a:hs'),
      replacement: forged as never,
    });
    const names: Record<string, string> = { '@a:hs': 'Alice', '@b:hs': 'Bob' };
    const room = {
      ...fakeRoom([event]),
      getMember: (id: string) =>
        names[id] ? { name: names[id], getMxcAvatarUrl: () => null } : null,
    };
    const revision = () =>
      eventRevision(
        fakeClient(fakeRoom([event]), []) as unknown as MatrixClient,
        room as unknown as Room,
        event as unknown as MatrixEvent,
        false,
      );

    const before = revision();
    names['@b:hs'] = 'Bobby';
    expect(revision()).toBe(before);
    names['@a:hs'] = 'Alicia';
    expect(revision()).not.toBe(before);
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
      ...fakeRoom(events),
      getMember: (id: string) => {
        if (id === '@me:hs') {
          return { name: 'Me', getMxcAvatarUrl: () => null };
        }
        return bobLoaded ? { name: 'Bob', getMxcAvatarUrl: () => null } : null;
      },
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        if (ev === RoomStateEvent.Members) {
          memberHandler = cb;
        }
      },
    };
    const client = clientFor(room);
    const svc = openTimeline(client);

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
      ...fakeRoom(events, { $1: relations }),
      getMember: (id: string) => {
        if (id === '@me:hs') {
          return { name: 'Me', getMxcAvatarUrl: () => null };
        }
        return aliceLoaded
          ? { name: 'Alice', getMxcAvatarUrl: () => null }
          : null;
      },
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        if (ev === RoomStateEvent.Members) {
          memberHandler = cb;
        }
      },
    };
    const client = clientFor(room);
    const svc = openTimeline(client);

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
      ...fakeRoom(events),
      getMember: (id: string) => {
        memberCalls++;
        return {
          name: id === '@me:hs' ? 'Me' : 'Alice',
          getMxcAvatarUrl: () => null,
        };
      },
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        if (ev === RoomStateEvent.Members) {
          memberHandler = cb;
        }
      },
    };
    const client = clientFor(room);
    openTimeline(client);
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

  it('re-projects an unreadable message when its failure reason changes', () => {
    const failed = {
      ...fakeEvent({ id: '$e', sender: '@a:hs', decryptFail: true }),
      decryptionFailureReason:
        DecryptionFailureCode.HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED as
          DecryptionFailureCode | undefined,
    };
    const room = fakeRoom([failed]);
    const client = fakeClient(room, []);
    const revision = () =>
      eventRevision(
        client as unknown as MatrixClient,
        room as unknown as Room,
        failed as unknown as MatrixEvent,
        false,
      );

    const before = revision();
    failed.decryptionFailureReason =
      DecryptionFailureCode.HISTORICAL_MESSAGE_WORKING_BACKUP;

    expect(revision()).not.toBe(before);
  });

  it('resets loadingOlder after a failed scrollback so pagination can retry', async () => {
    const room = {
      ...fakeRoom([]),
      getLiveTimeline: () => ({
        getEvents: () => [],
        getPaginationToken: () => 'tok',
        getState: () => undefined,
      }),
    };
    const client = clientFor(room, {
      scrollback: () => Promise.reject(new Error('network')),
    });
    const svc = openTimeline(client);

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
    const room = fakeRoom(events);
    const client = clientFor(room, {
      sendReadReceipt: (e: { getId: () => string }) => {
        received.push(e);
        return Promise.resolve({});
      },
    });
    openTimeline(client);

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
      const room = fakeRoom(events);
      const client = clientFor(room, {
        sendReadReceipt: (e: { getId: () => string }, type: string) => {
          received.push({ id: e.getId(), type });
          return Promise.resolve({});
        },
      });
      openTimeline(client, [privacyProvider(sendReceipts)]);

      expect(received).toEqual([{ id: '$a', type: expected }]);
    },
  );

  it('does not ack the open room while the window is unfocused (badge accrues)', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false); // app not in focus
    const received: { getId: () => string }[] = [];
    const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
    const room = fakeRoom(events);
    const client = clientFor(room, {
      sendReadReceipt: (e: { getId: () => string }) => {
        received.push(e);
        return Promise.resolve({});
      },
    });
    openTimeline(client);

    expect(received).toHaveLength(0); // unfocused → held back so unread accrues
  });

  it('re-acks the open room when the window regains focus', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false); // start unfocused
    const received: { getId: () => string }[] = [];
    const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
    const room = fakeRoom(events);
    const client = clientFor(room, {
      sendReadReceipt: (e: { getId: () => string }) => {
        received.push(e);
        return Promise.resolve({});
      },
    });
    openTimeline(client);
    expect(received).toHaveLength(0); // unfocused: not acked yet

    vi.spyOn(document, 'hasFocus').mockReturnValue(true); // user returns
    window.dispatchEvent(new Event('focus')); // → onFocus → markRead

    expect(received.map((e) => e.getId())).toEqual(['$a']);
  });

  it('close() removes the focus listener so a closed room is not re-acked on focus', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false); // start unfocused
    const received: { getId: () => string }[] = [];
    const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
    const room = fakeRoom(events);
    const client = clientFor(room, {
      sendReadReceipt: (e: { getId: () => string }) => {
        received.push(e);
        return Promise.resolve({});
      },
    });
    const svc = openTimeline(client);
    expect(received).toHaveLength(0); // unfocused: not acked yet

    svc.close();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true); // user returns
    window.dispatchEvent(new Event('focus')); // no room is open — must be a no-op

    expect(received).toHaveLength(0); // the closed room is never re-acked
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

  it('projects through an explicitly keyed Account client instead of the active pointer', () => {
    const room = fakeRoom([
      fakeEvent({ id: '$keyed', sender: '@alice:hs', body: 'keyed' }),
    ]);
    const keyedClient = fakeClient(room, []);
    const activeClient = fakeClient(fakeRoom([]), []);
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        matrixProvider(activeClient),
        mediaProvider(),
      ],
    });
    const svc = TestBed.inject(TimelineService);

    svc.open('!r:hs', keyedClient as never);

    expect(svc.openContext()?.client).toBe(keyedClient);
    expect(svc.messages().map((message) => message.id)).toEqual(['$keyed']);
  });

  it('coalesces a burst of timeline events into a single re-projection', async () => {
    // matrix-js-sdk emits RoomEvent.Timeline once PER event, so paginating 30 messages
    // fires the handler 30 times. refresh() walks every loaded event (fingerprinting
    // each), so refreshing per event makes a burst quadratic. A burst must therefore
    // cost the same as one event — mirroring RoomLibraryService.scheduleRefresh.
    let timelineHandler: (() => void) | undefined;
    let scans = 0;
    const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
    const room = {
      ...fakeRoom(events),
      getLiveTimeline: () => ({
        getEvents: () => {
          scans++;
          return events;
        },
        getPaginationToken: () => null,
        getState: () => undefined,
      }),
      on: (ev: string, cb: () => void) => {
        if (ev === RoomEvent.Timeline) {
          timelineHandler = cb;
        }
      },
    };
    openTimeline(clientFor(room));

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
      ...fakeRoom(events),
      on: (ev: string, cb: () => void) => {
        if (ev === RoomEvent.Timeline) {
          timelineHandler = cb;
        }
      },
    };
    openTimeline(
      clientFor(room, {
        sendReadReceipt: (e: { getId: () => string }) => {
          received.push(e);
          return Promise.resolve({});
        },
      }),
    );

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
        ...fakeRoom(events),
        getMember: (id: string) => {
          if (id === '@reader:hs') {
            return readerLoaded
              ? { name: 'Reader', getMxcAvatarUrl: () => 'mxc://hs/reader' }
              : null;
          }
          return { name: 'A', getMxcAvatarUrl: () => null };
        },
        getUsersReadUpTo: () => ['@reader:hs'],
        on: (ev: string, cb: (...a: unknown[]) => void) => {
          if (ev === RoomStateEvent.Members) {
            memberHandler = cb;
          }
        },
      };
      const svc = openTimeline(clientFor(room));

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
        '<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>',
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
        loadMembersIfNeeded: () => Promise.resolve(true),
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
        hasEncryptionStateEvent: () => false,
        // Room state hangs off the live timeline (what liveRoomState() reads, and what
        // the SDK's deprecated `currentState` aliased).
        loadMembersIfNeeded: () => Promise.resolve(true),
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
      const editSaying = (editId: string, body: string) => ({
        ...fakeEdit('$a'),
        getId: () => editId,
        getOriginalContent: () => ({
          'm.new_content': { msgtype: 'm.text', body },
        }),
      });
      const opts: Parameters<typeof fakeEvent>[0] = {
        id: '$a',
        sender: '@a:hs',
        body: 'first wording',
        replacement: editSaying('$newer', 'newest wording'),
      };
      const { svc, client, event } = openWithEvent(opts);
      expect(svc.messages()[0].body).toBe('newest wording');

      // What the SDK does after the newest edit is redacted: the same event now resolves to
      // the earlier edit, and it emits Replaced rather than a timeline change.
      opts.replacement = editSaying('$older', 'earlier wording');
      client.handlers.get('Event.replaced')?.(event);

      await vi.waitFor(() =>
        expect(svc.messages()[0].body).toBe('earlier wording'),
      );
      expect(svc.messages()[0].edited).toBe(true);
    });

    it('moves to another encrypted edit only once that edit is checked', async () => {
      const editSaying = (editId: string, body: string) => ({
        ...fakeEdit('$a', true),
        getId: () => editId,
        getOriginalContent: () => ({
          'm.new_content': { msgtype: 'm.text', body },
        }),
      });
      const newer = editSaying('$newer', 'newest wording');
      const older = editSaying('$older', 'earlier wording');
      resolvedShields.set(newer as never, null);
      const opts: Parameters<typeof fakeEvent>[0] = {
        id: '$a',
        sender: '@a:hs',
        body: 'first wording',
        encrypted: true,
        replacement: newer,
      };
      const { svc, client, event } = openWithEvent(opts);
      expect(svc.messages()[0].body).toBe('newest wording');

      opts.replacement = older;
      client.handlers.get('Event.replaced')?.(event);
      await vi.waitFor(() =>
        expect(svc.messages()[0].body).toBe('first wording'),
      );
      expect(svc.messages()[0].edited).toBe(false);

      resolvedShields.set(older as never, null);
      client.handlers.get('Event.replaced')?.(event);
      await vi.waitFor(() =>
        expect(svc.messages()[0].body).toBe('earlier wording'),
      );
      expect(svc.messages()[0].edited).toBe(true);
    });

    it("shows the message's first wording again once its only edit is removed", async () => {
      const opts = {
        id: '$a',
        sender: '@a:hs',
        body: 'first wording',
        edited: true,
      };
      const { svc, client, event } = openWithEvent(opts);
      expect(svc.messages()[0].body).toBe(`first wording${EDITED_MARK}`);
      expect(svc.messages()[0].edited).toBe(true);

      // What the SDK does after the only edit is redacted: the same event now reads as
      // its first wording, and it emits Replaced rather than a timeline change.
      opts.edited = false;
      client.handlers.get('Event.replaced')?.(event);

      await vi.waitFor(() =>
        expect(svc.messages()[0].body).toBe('first wording'),
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
});
