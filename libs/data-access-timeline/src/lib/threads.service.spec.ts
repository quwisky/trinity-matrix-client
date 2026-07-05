import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import {
  RoomEvent,
  RoomStateEvent,
  ThreadEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ThreadsService } from './threads.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { MediaService, type UploadedMedia } from '@trinity/data-access-media';

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
  editRelation?: boolean;
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
    isRelation: (relType?: string) =>
      o.editRelation === true &&
      (relType === undefined || relType === 'm.replace'),
    replacingEvent: () => (o.editRelation ? {} : null),
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
  paginationToken?: string | null;
}) {
  const events = o.events ?? [];
  // A minimal EventTimeline shim: the service paginates `liveTimeline` and reads
  // its backward pagination token to drive `canPaginateThread`.
  const liveTimeline = {
    _token: o.paginationToken ?? null,
    getEvents: () => events,
    getPaginationToken: () => liveTimeline._token,
  };
  return {
    id: o.id,
    rootEvent: o.rootEvent,
    events,
    replyToEvent: o.replyToEvent ?? null,
    length: o.length ?? o.events?.length ?? 0,
    liveTimeline,
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
  extraEvents: FakeEvent[] = [],
) {
  const all = [
    ...extraEvents,
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
    // Mirrors Room.createThread: registers a new Thread so a later getThread finds
    // it — matches openThread eagerly creating a thread for a brand-new reply.
    createThread: (
      threadId: string,
      rootEvent: FakeEvent | undefined,
      events: FakeEvent[] | undefined,
    ) => {
      const created = fakeThread({
        id: threadId,
        rootEvent,
        events: events?.length ? events : rootEvent ? [rootEvent] : [],
      });
      threads.push(created);
      return created;
    },
    getMember: (id: string) => ({
      name: MEMBERS[id] ?? id,
      getMxcAvatarUrl: () => null,
    }),
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
    hasEncryptionStateEvent: () => false,
    ...emitter(),
  };
  const client = {
    getRoom: () => room,
    getUserId: () => '@me:hs',
    // Fetch a thread root that isn't in memory (raw IEvent, as the SDK returns).
    fetchRoomEvent: vi.fn((_rid: string, eventId: string) =>
      Promise.resolve({
        event_id: eventId,
        type: 'm.room.message',
        sender: '@a:hs',
        room_id: '!r:hs',
        origin_server_ts: 0,
        content: { body: 'fetched root', msgtype: 'm.text' },
      }),
    ),
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
  TestBed.configureTestingModule({
    providers: [
      ThreadsService,
      // `isInitialized` and `instance` are getters on the real service; MockProvider
      // overrides them so the service reads our SDK-shaped fakes.
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: client as unknown as MatrixClient,
      }),
      MockProvider(MediaService, {
        uploadMedia: fakeMediaService().uploadMedia,
      }),
    ],
  });
  const svc = TestBed.inject(ThreadsService);
  return { svc, room, client, sent };
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

  it('refreshes a thread summary when a participant’s profile loads late', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const reply = fakeEvent({
      id: '$r1',
      sender: '@b:hs',
      body: 'a reply',
      ts: 1000,
    });
    const { svc, room } = setup([
      fakeThread({
        id: '$root',
        rootEvent: root,
        events: [root, reply],
        replyToEvent: reply,
        length: 1,
      }),
    ]);
    // The replier @b:hs isn't in room state yet (lazy loading), then arrives.
    let bobLoaded = false;
    room.getMember = ((id: string) =>
      id === '@b:hs'
        ? bobLoaded
          ? { name: 'Bob', getMxcAvatarUrl: () => 'mxc://hs/bob' }
          : null
        : {
            name: MEMBERS[id] ?? id,
            getMxcAvatarUrl: () => null,
          }) as unknown as typeof room.getMember;
    svc.open('!r:hs');

    const before = svc.summaries()['$root'];
    const bobBefore = before.participants.find((p) => p.id === '@b:hs');
    expect(bobBefore?.name).toBe('@b:hs'); // mxid fallback
    expect(bobBefore?.avatarMxc).toBeNull();
    expect(before.latestReplySenderName).toBe('@b:hs');

    // The member's profile arrives; the room re-emits its state Members event.
    bobLoaded = true;
    room.emit(
      RoomStateEvent.Members,
      {},
      {},
      { roomId: '!r:hs', userId: '@b:hs' },
    );

    const after = svc.summaries()['$root'];
    const bobAfter = after.participants.find((p) => p.id === '@b:hs');
    expect(bobAfter?.name).toBe('Bob');
    expect(bobAfter?.avatarMxc).toBe('mxc://hs/bob');
    expect(after.latestReplySenderName).toBe('Bob');
  });

  it('does not rebuild a summary when a non-participant member changes', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const reply = fakeEvent({
      id: '$r1',
      sender: '@b:hs',
      body: 'a reply',
      ts: 1000,
    });
    const { svc, room } = setup([
      fakeThread({
        id: '$root',
        rootEvent: root,
        events: [root, reply],
        replyToEvent: reply,
        length: 1,
      }),
    ]);
    svc.open('!r:hs');
    const before = svc.summaries()['$root'];

    // A member the summary doesn't render → no rebuild, same object identity.
    room.emit(
      RoomStateEvent.Members,
      {},
      {},
      { roomId: '!r:hs', userId: '@stranger:hs' },
    );
    expect(svc.summaries()['$root']).toBe(before);

    // A rendered participant → the summary is rebuilt (fresh object).
    room.emit(
      RoomStateEvent.Members,
      {},
      {},
      { roomId: '!r:hs', userId: '@a:hs' },
    );
    expect(svc.summaries()['$root']).not.toBe(before);
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

  it('refreshes an in-thread reply preview when the quoted sender loads late', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const reply = fakeEvent({
      id: '$r1',
      sender: '@me:hs',
      body: 'my reply',
      replyTo: '$root',
    });
    const { svc, room } = setup([
      fakeThread({ id: '$root', rootEvent: root, events: [root, reply] }),
    ]);
    // The quoted sender @a:hs isn't in room state yet (lazy loading), then arrives.
    let aliceLoaded = false;
    room.getMember = ((id: string) =>
      id === '@a:hs'
        ? aliceLoaded
          ? { name: 'Alice', getMxcAvatarUrl: () => 'mxc://hs/av' }
          : null
        : {
            name: MEMBERS[id] ?? id,
            getMxcAvatarUrl: () => null,
          }) as unknown as typeof room.getMember;
    svc.openThread('!r:hs', '$root');

    const before = svc.threadMessages().find((m) => m.id === '$r1');
    expect(before?.replyTo?.senderName).toBe('@a:hs'); // mxid fallback
    expect(before?.replyTo?.senderAvatarMxc).toBeNull();

    // The member's profile arrives; the room re-emits its state Members event.
    aliceLoaded = true;
    room.emit(
      RoomStateEvent.Members,
      {},
      {},
      { roomId: '!r:hs', userId: '@a:hs' },
    );

    const after = svc.threadMessages().find((m) => m.id === '$r1');
    expect(after?.replyTo?.senderName).toBe('Alice');
    expect(after?.replyTo?.senderAvatarMxc).toBe('mxc://hs/av');
  });

  it('does not re-project the thread when an unreferenced member changes', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const reply = fakeEvent({ id: '$r1', sender: '@b:hs', body: 'a reply' });
    const { svc, room } = setup([
      fakeThread({ id: '$root', rootEvent: root, events: [root, reply] }),
    ]);
    let memberCalls = 0;
    const base = room.getMember;
    room.getMember = (id: string) => {
      memberCalls++;
      return base(id);
    };
    svc.openThread('!r:hs', '$root');
    const baseline = memberCalls;

    // A member the thread doesn't render → gated out, no re-projection.
    room.emit(
      RoomStateEvent.Members,
      {},
      {},
      { roomId: '!r:hs', userId: '@stranger:hs' },
    );
    expect(memberCalls).toBe(baseline);

    // A referenced sender → re-projects.
    room.emit(
      RoomStateEvent.Members,
      {},
      {},
      { roomId: '!r:hs', userId: '@a:hs' },
    );
    expect(memberCalls).toBeGreaterThan(baseline);
  });

  it('excludes m.replace edit events from the thread messages', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const reply = fakeEvent({ id: '$r1', sender: '@b:hs', body: 'a reply' });
    const edit = fakeEvent({
      id: '$e1',
      sender: '@b:hs',
      body: '* edited reply',
      editRelation: true,
    });
    const { svc } = setup([
      fakeThread({ id: '$root', rootEvent: root, events: [root, reply, edit] }),
    ]);
    svc.openThread('!r:hs', '$root');

    // The edit (an m.replace relation) is filtered out by isDisplayableMessage —
    // only the root and the original reply remain.
    expect(svc.threadMessages().map((m) => m.id)).toEqual(['$root', '$r1']);
  });

  it('creates the thread only on the first send, not on open, so the reply surfaces', async () => {
    // "Reply in thread" on a plain message: no thread exists yet, but the root does.
    const root = fakeEvent({ id: '$root', sender: '@me:hs', body: 'root msg' });
    const { svc, room } = setup([], [], {}, [root]);
    svc.openThread('!r:hs', '$root');

    // Opening alone must NOT create a thread — else an empty 0-reply thread lingers
    // if the user never sends. The view is just the root.
    expect(room.getThread('$root')).toBeNull();
    expect(room.getThreads()).toHaveLength(0);
    expect(svc.threadMessages().map((m) => m.id)).toEqual(['$root']);

    // The first send creates + attaches the thread (matrix-js-sdk never forms one
    // from the sender's own first reply alone); the reply then surfaces live.
    await firstValueFrom(svc.sendToThread('first reply'));
    const thread = room.getThread('$root');
    expect(thread).not.toBeNull();
    if (!thread) return;

    const reply = fakeEvent({
      id: '$r1',
      sender: '@me:hs',
      body: 'first reply',
    });
    thread.events.push(reply);
    thread.emit(ThreadEvent.NewReply);
    expect(svc.threadMessages().map((m) => m.id)).toEqual(['$root', '$r1']);
  });

  it('fetches the thread root when missing so the first reply still shows', async () => {
    // Replying in a thread whose root isn't in memory (scrolled out / unsynced).
    const { svc, room, client, sent } = setup([]);
    svc.openThread('!r:hs', '$missing');
    expect(room.getThread('$missing')).toBeNull();

    await firstValueFrom(svc.sendToThread('hi'));

    // The root is fetched and a local Thread created so the echo has a home...
    expect(client.fetchRoomEvent).toHaveBeenCalledWith('!r:hs', '$missing');
    expect(room.getThread('$missing')).not.toBeNull();
    // ...and only then is the threaded reply sent.
    expect(sent).toEqual([['text', '$missing', 'hi']]);
  });

  it('aborts the threaded send when the root cannot be fetched', async () => {
    const { svc, room, client, sent } = setup([]);
    (client.fetchRoomEvent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('not found'),
    );
    svc.openThread('!r:hs', '$gone');

    // The send surfaces the fetch error instead of emitting a homeless echo.
    await expect(firstValueFrom(svc.sendToThread('hi'))).rejects.toThrow(
      'not found',
    );
    expect(room.getThread('$gone')).toBeNull();
    expect(sent).toEqual([]);
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
          '',
        ),
      );

      expect(sent[0][0]).toBe('message');
      expect(sent[0][1]).toBe('$root'); // threadId
      const content = sent[0][2] as Record<string, unknown>;
      expect(content['msgtype']).toBe('m.image');
      expect(content['url']).toBe('mxc://hs/up');
      expect(content['body']).toBe('pic.png'); // no caption → body is the filename
      expect(content['filename']).toBeUndefined();
    });

    it('sends a caption with thread media as MSC2530 body + filename', async () => {
      const { svc, sent } = openedThread();

      await firstValueFrom(
        svc.sendMediaToThread(
          new File([new Uint8Array([1, 2, 3, 4])], 'pic.png', {
            type: 'image/png',
          }),
          'in-thread caption',
        ),
      );

      const content = sent[0][2] as Record<string, unknown>;
      expect(content['body']).toBe('in-thread caption'); // body carries the caption
      expect(content['filename']).toBe('pic.png'); // real name preserved
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

  describe('history pagination', () => {
    it('exposes canPaginate from the thread timeline’s backward token', () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const { svc } = setup([
        fakeThread({
          id: '$root',
          rootEvent: root,
          events: [root],
          paginationToken: 'tok',
        }),
      ]);
      svc.openThread('!r:hs', '$root');

      expect(svc.canPaginateThread()).toBe(true);
    });

    it('pages older replies into the thread, then re-maps + clears the token', async () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const newer = fakeEvent({
        id: '$r2',
        sender: '@b:hs',
        body: 'newer',
        ts: 2000,
      });
      const thread = fakeThread({
        id: '$root',
        rootEvent: root,
        events: [root, newer],
        paginationToken: 'tok',
      });
      const { svc, client } = setup([thread]);

      // Stub the SDK pagination: prepend an older reply and clear the token.
      const older = fakeEvent({
        id: '$r1',
        sender: '@a:hs',
        body: 'older',
        ts: 1000,
      });
      let calledWith: unknown;
      (
        client as unknown as {
          paginateEventTimeline: (t: unknown, o: unknown) => Promise<boolean>;
        }
      ).paginateEventTimeline = (timeline, opts) => {
        calledWith = { timeline, opts };
        // Older replies land after the root (a thread's oldest event) and before
        // the already-loaded ones, mirroring the SDK's backward pagination.
        thread.events.splice(1, 0, older);
        thread.liveTimeline._token = null;
        return Promise.resolve(true);
      };

      svc.openThread('!r:hs', '$root');
      expect(svc.threadMessages().map((m) => m.id)).toEqual(['$root', '$r2']);
      expect(svc.canPaginateThread()).toBe(true);

      await firstValueFrom(svc.paginateOpenThread());

      // Paginated the thread's own live timeline, backwards.
      expect(calledWith).toEqual({
        timeline: thread.liveTimeline,
        opts: { backwards: true, limit: 30 },
      });
      // Older reply prepended (root still first), token cleared, flag reset.
      expect(svc.threadMessages().map((m) => m.id)).toEqual([
        '$root',
        '$r1',
        '$r2',
      ]);
      expect(svc.canPaginateThread()).toBe(false);
      expect(svc.loadingOlderThread()).toBe(false);
    });

    it('is a no-op when no thread is open', async () => {
      const { svc, client } = setup([]);
      const paginate = vi.fn();
      (
        client as unknown as { paginateEventTimeline: unknown }
      ).paginateEventTimeline = paginate;

      await firstValueFrom(svc.paginateOpenThread());

      expect(paginate).not.toHaveBeenCalled();
    });
  });

  describe('unread badges', () => {
    it('carries each thread’s unread count + highlight in the summary', () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const reply = fakeEvent({
        id: '$r1',
        sender: '@b:hs',
        body: 'reply',
        ts: 1000,
      });
      const { svc, room } = setup([
        fakeThread({
          id: '$root',
          rootEvent: root,
          events: [root, reply],
          replyToEvent: reply,
          length: 1,
        }),
      ]);
      (
        room as unknown as {
          getThreadUnreadNotificationCount: (i: string, t: string) => number;
        }
      ).getThreadUnreadNotificationCount = (_id, type) =>
        type === 'highlight' ? 1 : 3;

      svc.open('!r:hs');

      const summary = svc.summaries()['$root'];
      expect(summary.unreadCount).toBe(3);
      expect(summary.highlight).toBe(true);
    });

    it('defaults to read when the per-thread count API is unavailable', () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const { svc } = setup([
        fakeThread({ id: '$root', rootEvent: root, events: [root] }),
      ]);
      // setup()'s room has no getThreadUnreadNotificationCount — must not throw.
      svc.open('!r:hs');

      expect(svc.summaries()['$root'].unreadCount).toBe(0);
      expect(svc.summaries()['$root'].highlight).toBe(false);
    });

    it('refreshes unread counts live on UnreadNotifications', () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const reply = fakeEvent({
        id: '$r1',
        sender: '@b:hs',
        body: 'reply',
        ts: 1000,
      });
      const { svc, room } = setup([
        fakeThread({
          id: '$root',
          rootEvent: root,
          events: [root, reply],
          replyToEvent: reply,
          length: 1,
        }),
      ]);
      let total = 0;
      (
        room as unknown as {
          getThreadUnreadNotificationCount: () => number;
        }
      ).getThreadUnreadNotificationCount = () => total;

      svc.open('!r:hs');
      expect(svc.summaries()['$root'].unreadCount).toBe(0);

      total = 4;
      room.emit(RoomEvent.UnreadNotifications);
      expect(svc.summaries()['$root'].unreadCount).toBe(4);
    });

    it('marks the opened thread read via a thread-scoped read receipt', () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const reply = fakeEvent({
        id: '$r1',
        sender: '@b:hs',
        body: 'reply',
        ts: 1000,
      });
      const receipts: [string, string][] = [];
      const { svc, client } = setup([
        fakeThread({ id: '$root', rootEvent: root, events: [root, reply] }),
      ]);
      (
        client as unknown as {
          sendReadReceipt: (e: FakeEvent, t: string) => Promise<unknown>;
        }
      ).sendReadReceipt = (event, type) => {
        receipts.push([event.getId(), type]);
        return Promise.resolve({});
      };

      svc.openThread('!r:hs', '$root');

      // Receipt for the latest reply (not the root), with ReceiptType.Read.
      expect(receipts).toEqual([['$r1', 'm.read']]);
    });

    it('does not throw when the read-receipt API is unavailable', () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const { svc } = setup([
        fakeThread({ id: '$root', rootEvent: root, events: [root] }),
      ]);
      // setup()'s client has no sendReadReceipt — opening must still succeed.
      expect(() => svc.openThread('!r:hs', '$root')).not.toThrow();
      expect(svc.threadMessages().map((m) => m.id)).toEqual(['$root']);
    });
  });

  describe('threads list', () => {
    it('lists threads sorted by latest activity, newest first', () => {
      const older = fakeThread({
        id: '$old',
        rootEvent: fakeEvent({
          id: '$old',
          sender: '@a:hs',
          body: 'old root',
          ts: 100,
        }),
        replyToEvent: fakeEvent({
          id: '$or',
          sender: '@b:hs',
          body: 'old reply',
          ts: 200,
        }),
        length: 1,
      });
      const newer = fakeThread({
        id: '$new',
        rootEvent: fakeEvent({
          id: '$new',
          sender: '@a:hs',
          body: 'new root',
          ts: 300,
        }),
        replyToEvent: fakeEvent({
          id: '$nr',
          sender: '@b:hs',
          body: 'new reply',
          ts: 900,
        }),
        length: 1,
      });
      const { svc } = setup([older, newer]);
      svc.open('!r:hs');

      const list = svc.threadList();
      expect(list.map((t) => t.rootEventId)).toEqual(['$new', '$old']);
      expect(list[0].latestActivityTs).toBe(900);
      expect(list[0].rootPreview).toBe('new root');
    });
  });
});
