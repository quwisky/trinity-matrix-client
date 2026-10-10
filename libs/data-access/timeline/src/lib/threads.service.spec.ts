import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import {
  MatrixEventEvent,
  RoomEvent,
  RoomStateEvent,
  ThreadEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import {
  CryptoEvent,
  EventShieldColour,
  EventShieldReason,
} from 'matrix-js-sdk/lib/crypto-api';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { ThreadsService } from './threads.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MediaService, type UploadedMedia } from '@trinity/data-access/media';
import { switchableMatrixProvider } from './timeline.spec-harness';
import { CONVERSATION_MESSAGE_ADAPTER } from './conversation-message-adapter.service';
import type { ConversationMessageOutcome } from './conversation-messages';

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
    listenerCount(ev: string) {
      return (handlers[ev] ?? []).length;
    },
  };
}

/** A settled edit as `replacingEvent()` returns it, in the clear unless told otherwise. */
function fakeEdit(id: string, encrypted = false, ts = 0) {
  return {
    getId: () => `${id}~edit`,
    getTs: () => ts,
    isEncrypted: () => encrypted,
    isDecryptionFailure: () => false,
    isRedacted: () => false,
    isState: () => false,
    status: null,
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
  encrypted?: boolean;
  replyTo?: string;
  status?: string | null;
  editRelation?: boolean;
  stateKey?: string;
  /** The event `replacingEvent()` returns: the latest edit of this one. */
  replacement?: ReturnType<typeof fakeEdit>;
}) {
  return {
    getId: () => o.id,
    getSender: () => o.sender,
    getTs: () => o.ts ?? 0,
    getType: () => o.type ?? 'm.room.message',
    isState: () => o.stateKey !== undefined,
    getRoomId: () => '!r:hs',
    getContent: () => ({ body: o.body ?? '', msgtype: 'm.text' }),
    isRedacted: () => o.redacted ?? false,
    isDecryptionFailure: () => o.decryptFail ?? false,
    isEncrypted: () => o.encrypted ?? false,
    isRelation: (relType?: string) =>
      o.editRelation === true &&
      (relType === undefined || relType === 'm.replace'),
    replacingEvent: () => o.replacement ?? (o.editRelation ? {} : null),
    replyEventId: o.replyTo,
    status: o.status ?? null,
  };
}

type FakeEvent = ReturnType<typeof fakeEvent>;

type FakeRelations = {
  getSortedAnnotationsByKey: () => [string, Set<unknown>][];
};

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

function stubPaginate(client: unknown, fn: () => Promise<boolean>): void {
  (
    client as { paginateEventTimeline: () => Promise<boolean> }
  ).paginateEventTimeline = fn;
}

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
  reactions: Record<string, FakeRelations> = {},
  extraEvents: FakeEvent[] = [],
  _sendReadReceipts = true,
  getEncryptionInfoForEvent?: Mock,
  roomEncrypted = false,
  storeEncrypted = false,
  encryptionTs?: number,
) {
  const all = [
    ...extraEvents,
    ...threads.flatMap((t) => [
      ...(t.rootEvent ? [t.rootEvent] : []),
      ...t.events,
    ]),
  ];
  // Thread replies live on their thread; only roots and plain messages are in the
  // room's main timeline.
  const mainTimeline = [
    ...extraEvents,
    ...threads.flatMap((t) => (t.rootEvent ? [t.rootEvent] : [])),
  ];
  const room = {
    roomId: '!r:hs',
    getLiveTimeline: () => ({
      getEvents: () => mainTimeline,
      // The room's current `m.room.encryption` state event, dated `encryptionTs`.
      getState: () =>
        encryptionTs === undefined
          ? undefined
          : {
              getStateEvents: (type: string) =>
                type === 'm.room.encryption'
                  ? { getTs: () => encryptionTs }
                  : null,
            },
    }),
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
    // Typed with its parameter (rather than `() => []`) so a test can re-point it at a
    // per-event reader list without fighting the inferred signature.
    getUsersReadUpTo: (_event: { getId: () => string }): string[] => [],
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
    hasEncryptionStateEvent: () => roomEncrypted,
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
    ...(getEncryptionInfoForEvent || storeEncrypted
      ? {
          getCrypto: () => ({
            getEncryptionInfoForEvent:
              getEncryptionInfoForEvent ?? vi.fn(() => Promise.resolve(null)),
            isEncryptionEnabledInRoom: () => Promise.resolve(storeEncrypted),
          }),
        }
      : {}),
    ...emitter(),
  };
  const acknowledge = vi.fn(() =>
    of<ConversationMessageOutcome>({
      kind: 'applied',
      operation: 'receipt',
    }),
  );
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
      { provide: CONVERSATION_MESSAGE_ADAPTER, useValue: { acknowledge } },
    ],
  });
  const svc = TestBed.inject(ThreadsService);
  svc.attach(
    { accountId: '@me:hs', roomId: '!r:hs' },
    client as unknown as MatrixClient,
  );
  return { svc, room, client, sent, acknowledge };
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
    const { svc, room, client } = setup([
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
    svc.close();
    svc.attach(
      { accountId: '@me:hs', roomId: '!r:hs' },
      client as unknown as MatrixClient,
    );

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
    svc.attachThreadRoot('$root');

    const msgs = svc.threadMessages();
    expect(msgs.map((m) => m.id)).toEqual(['$root', '$r1']);
    expect(msgs[0].body).toBe('root msg');
    expect(svc.openThreadRootId()).toBe('$root');
  });

  it('follows a read receipt onto an open thread’s replies', async () => {
    // A receipt is none of the thread-level events attachThreadRoot listens to, so without a
    // room-level Receipt listener the "seen by" avatars under a reply sat unchanged
    // until some unrelated event happened to re-refresh the thread. The summaries
    // projection has bound this all along; the open thread had not.
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const reply = fakeEvent({ id: '$r1', sender: '@b:hs', body: 'a reply' });
    const { svc, room } = setup([
      fakeThread({ id: '$root', rootEvent: root, events: [root, reply] }),
    ]);
    svc.attachThreadRoot('$root');
    expect(svc.threadMessages()[1].readReceipts).toEqual([]);

    let readers: string[] = [];
    room.getUsersReadUpTo = (event: { getId: () => string }) =>
      event.getId() === '$r1' ? readers : [];
    readers = ['@c:hs'];
    room.emit(RoomEvent.Receipt);
    await Promise.resolve(); // the re-projection is coalesced into a microtask

    expect(svc.threadMessages()[1].readReceipts.map((r) => r.userId)).toEqual([
      '@c:hs',
    ]);
  });

  it('reuses reply views whose inputs are unchanged across a refresh', () => {
    // Each rebuild is a markdown render + DOMPurify sanitize, and refreshThread runs on
    // Timeline/LocalEcho/Decrypted/Members — so without a cache an unrelated event
    // rebuilt every reply and handed every OnPush row a new identity.
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const reply = fakeEvent({ id: '$r1', sender: '@b:hs', body: 'a reply' });
    const { svc, room } = setup([
      fakeThread({ id: '$root', rootEvent: root, events: [root, reply] }),
    ]);
    svc.attachThreadRoot('$root');
    const before = svc.threadMessages();

    // A member event for someone the thread renders re-projects it — but nothing these
    // replies read has actually changed, so the view objects must survive.
    room.emit(
      RoomStateEvent.Members,
      {},
      {},
      { roomId: '!r:hs', userId: '@b:hs' },
    );

    const after = svc.threadMessages();
    expect(after[0]).toBe(before[0]); // same object, not merely equal
    expect(after[1]).toBe(before[1]);
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
    svc.attachThreadRoot('$root');

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
    svc.attachThreadRoot('$root');
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
    svc.attachThreadRoot('$root');

    // The edit (an m.replace relation) is filtered out by isDisplayableMessage —
    // only the root and the original reply remain.
    expect(svc.threadMessages().map((m) => m.id)).toEqual(['$root', '$r1']);
  });

  it('creates the thread only on the first send, not on open, so the reply surfaces', async () => {
    // "Reply in thread" on a plain message: no thread exists yet, but the root does.
    const root = fakeEvent({ id: '$root', sender: '@me:hs', body: 'root msg' });
    const { svc, room } = setup([], [], {}, [root]);
    svc.attachThreadRoot('$root');

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
    svc.attachThreadRoot('$missing');
    expect(room.getThread('$missing')).toBeNull();

    await firstValueFrom(svc.sendToThread('hi'));

    // The root is fetched and a local Thread created so the echo has a home...
    expect(client.fetchRoomEvent).toHaveBeenCalledWith('!r:hs', '$missing');
    expect(room.getThread('$missing')).not.toBeNull();
    // ...and only then is the threaded reply sent.
    expect(sent).toEqual([
      [
        'message',
        '$missing',
        { msgtype: 'm.text', body: 'hi', 'm.mentions': {} },
      ],
    ]);
  });

  it('aborts the threaded send when the root cannot be fetched', async () => {
    const { svc, room, client, sent } = setup([]);
    (client.fetchRoomEvent as Mock).mockRejectedValueOnce(
      new Error('not found'),
    );
    svc.attachThreadRoot('$gone');

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
    svc.attachThreadRoot('$root');

    expect(svc.threadMessages().map((m) => m.id)).toEqual(['$root', '$r1']);
  });

  it('projects an authenticity shield onto an encrypted thread message', async () => {
    const getInfo = vi.fn().mockResolvedValue({
      shieldColour: EventShieldColour.GREY,
      shieldReason: EventShieldReason.UNSIGNED_DEVICE,
    });
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
    const reply = fakeEvent({
      id: '$r1',
      sender: '@a:hs',
      body: 'secret reply',
      encrypted: true,
    });
    const { svc } = setup(
      [fakeThread({ id: '$root', rootEvent: root, events: [reply] })],
      [],
      {},
      [],
      true,
      getInfo,
    );

    svc.attachThreadRoot('$root');

    await vi.waitFor(() =>
      expect(
        svc.threadMessages().find((m) => m.id === '$r1')?.shield?.level,
      ).toBe('grey'),
    );
    expect(getInfo).toHaveBeenCalled();
  });

  describe('in a room with encryption enabled', () => {
    function openEncryptedThread(
      replies: FakeEvent[],
      getInfo: Mock = vi.fn(),
      {
        stateEncrypted = true,
        storeEncrypted = false,
        encryptionTs,
      }: {
        stateEncrypted?: boolean;
        storeEncrypted?: boolean;
        encryptionTs?: number;
      } = {},
    ) {
      const root = fakeEvent({
        id: '$root',
        sender: '@a:hs',
        body: 'root',
        encrypted: true,
      });
      const encryption = fakeEvent({
        id: '$enc',
        sender: '@a:hs',
        type: 'm.room.encryption',
        stateKey: '',
      });
      const made = setup(
        [fakeThread({ id: '$root', rootEvent: root, events: replies })],
        [],
        {},
        [encryption],
        true,
        getInfo,
        stateEncrypted,
        storeEncrypted,
        encryptionTs,
      );
      made.svc.attachThreadRoot('$root');
      return { ...made, getInfo };
    }

    const shieldOf = (
      svc: ThreadsService,
      id: string,
    ): { level: string } | null =>
      svc.threadMessages().find((m) => m.id === id)?.shield ?? null;

    it('marks a plaintext thread reply as not encrypted', () => {
      const { svc } = openEncryptedThread([
        fakeEvent({ id: '$plain', sender: '@a:hs', body: 'hi' }),
      ]);

      expect(shieldOf(svc, '$plain')).toEqual({
        level: 'unencrypted',
        reason: 'Not encrypted',
        explanation: 'This message was sent without end-to-end encryption.',
      });
    });

    it('leaves an encrypted reply on its crypto-derived shield', async () => {
      const getInfo = vi.fn().mockResolvedValue({
        shieldColour: EventShieldColour.GREY,
        shieldReason: EventShieldReason.UNSIGNED_DEVICE,
      });
      const { svc } = openEncryptedThread(
        [
          fakeEvent({
            id: '$sealed',
            sender: '@a:hs',
            body: 'hi',
            encrypted: true,
          }),
        ],
        getInfo,
      );

      await vi.waitFor(() =>
        expect(shieldOf(svc, '$sealed')).toMatchObject({ level: 'grey' }),
      );
    });

    it('marks a reply dated before encryption grey and one dated after it red', () => {
      const { svc } = openEncryptedThread(
        [
          fakeEvent({ id: '$old', sender: '@a:hs', body: 'one', ts: 500 }),
          fakeEvent({ id: '$new', sender: '@a:hs', body: 'two', ts: 1500 }),
        ],
        vi.fn(),
        { encryptionTs: 1000 },
      );

      expect(shieldOf(svc, '$old')).toEqual({
        level: 'unencrypted-history',
        reason: 'Not encrypted',
        explanation:
          'This message is dated before the room turned on end-to-end encryption.',
      });
      expect(shieldOf(svc, '$new')).toMatchObject({ level: 'unencrypted' });
    });

    it('marks every reply red when the room has no encryption state event', () => {
      const { svc } = openEncryptedThread([
        fakeEvent({ id: '$old', sender: '@a:hs', body: 'one', ts: 1 }),
        fakeEvent({ id: '$new', sender: '@a:hs', body: 'two', ts: 9999 }),
      ]);

      expect(shieldOf(svc, '$old')).toMatchObject({ level: 'unencrypted' });
      expect(shieldOf(svc, '$new')).toMatchObject({ level: 'unencrypted' });
    });

    it('marks an encrypted reply whose plaintext edit is dated after encryption red', () => {
      const { svc } = openEncryptedThread(
        [
          fakeEvent({
            id: '$sealed',
            sender: '@a:hs',
            body: 'edited text',
            encrypted: true,
            ts: 500,
            replacement: fakeEdit('$sealed', false, 1500),
          }),
        ],
        vi.fn(),
        { encryptionTs: 1000 },
      );

      expect(shieldOf(svc, '$sealed')).toMatchObject({ level: 'unencrypted' });
    });

    it('probes the crypto API with the edit, which supplies the text', async () => {
      const getInfo = vi.fn().mockResolvedValue({
        shieldColour: EventShieldColour.GREY,
        shieldReason: EventShieldReason.UNSIGNED_DEVICE,
      });
      const { svc } = openEncryptedThread(
        [
          fakeEvent({
            id: '$sealed',
            sender: '@a:hs',
            body: 'edited text',
            encrypted: true,
            replacement: fakeEdit('$sealed', true),
          }),
        ],
        getInfo,
      );

      await vi.waitFor(() =>
        expect(shieldOf(svc, '$sealed')).toMatchObject({ level: 'grey' }),
      );
      const probed = getInfo.mock.calls.map(([event]) => event.getId());
      expect(probed).toContain('$sealed~edit');
      expect(probed).not.toContain('$sealed');
    });

    it('does not show a state event of a message type as a reply', () => {
      const { svc } = openEncryptedThread([
        fakeEvent({
          id: '$state-message',
          sender: '@a:hs',
          body: 'keyed',
          stateKey: 'x',
        }),
        fakeEvent({ id: '$real', sender: '@a:hs', body: 'real' }),
      ]);

      const ids = svc.threadMessages().map((m) => m.id);
      expect(ids).not.toContain('$state-message');
      expect(ids).toContain('$real');
    });

    // Same rule as the main timeline: the SDK encrypts when the state says so OR the crypto
    // store has the room recorded as encrypted.
    it('marks a plaintext reply when only the crypto store knows the room is encrypted', async () => {
      const { svc } = openEncryptedThread(
        [fakeEvent({ id: '$plain', sender: '@a:hs', body: 'hi' })],
        vi.fn(),
        { stateEncrypted: false, storeEncrypted: true },
      );

      await vi.waitFor(() =>
        expect(shieldOf(svc, '$plain')).toMatchObject({ level: 'unencrypted' }),
      );
    });

    it('does not mark a pending reply', () => {
      const { svc } = openEncryptedThread([
        fakeEvent({
          id: '$echo',
          sender: '@me:hs',
          body: 'sending',
          status: 'sending',
        }),
      ]);

      expect(svc.threadMessages().map((m) => m.id)).toContain('$echo');
      expect(shieldOf(svc, '$echo')).toBeNull();
    });
  });

  it('shows no unencrypted shield in a room without encryption', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
    const reply = fakeEvent({ id: '$r1', sender: '@a:hs', body: 'plain' });
    const { svc } = setup([
      fakeThread({ id: '$root', rootEvent: root, events: [reply] }),
    ]);
    svc.attachThreadRoot('$root');

    expect(
      svc.threadMessages().find((m) => m.id === '$r1')?.shield ?? null,
    ).toBeNull();
  });

  it('renders the unable-to-decrypt fallback for an E2EE failure in a thread', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const failed = fakeEvent({ id: '$f', sender: '@b:hs', decryptFail: true });
    const { svc } = setup([
      fakeThread({ id: '$root', rootEvent: root, events: [root, failed] }),
    ]);
    svc.attachThreadRoot('$root');

    const failedView = svc.threadMessages().find((m) => m.id === '$f');
    expect(failedView?.decryptionFailed).toBe(true);
    expect(failedView?.body).toContain('Unable to decrypt');
  });

  it('clears state on close / closeThread', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const { svc, client } = setup([
      fakeThread({ id: '$root', rootEvent: root, events: [root] }),
    ]);

    expect(Object.keys(svc.summaries())).toHaveLength(1);
    svc.close();
    expect(svc.summaries()).toEqual({});

    svc.attach(
      { accountId: '@me:hs', roomId: '!r:hs' },
      client as unknown as MatrixClient,
    );
    svc.attachThreadRoot('$root');
    expect(svc.threadMessages()).toHaveLength(1);
    svc.closeThread();
    expect(svc.threadMessages()).toEqual([]);
    expect(svc.openThreadRootId()).toBeNull();
  });

  it('detaches the client listeners attachThreadRoot inherited on closeThread', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const { svc, client } = setup([
      fakeThread({ id: '$root', rootEvent: root, events: [root] }),
    ]);
    const on = vi.spyOn(client, 'on');
    const off = vi.spyOn(client, 'off');

    svc.attachThreadRoot('$root');
    // Only the final four calls belong to the exact thread child under test.
    const attached = on.mock.calls.slice(-4);
    expect(attached.map(([event]) => event)).toEqual([
      MatrixEventEvent.Decrypted,
      CryptoEvent.UserTrustStatusChanged,
      CryptoEvent.DevicesUpdated,
      CryptoEvent.KeysChanged,
    ]);

    svc.closeThread();
    // The handler references must be the ones that were attached — an `off` with a
    // fresh function leaves the listener bound.
    for (const [event, handler] of attached) {
      expect(off).toHaveBeenCalledWith(event, handler);
    }
    expect(off).toHaveBeenCalledTimes(attached.length);
  });

  it('detaches thread listeners from the account it opened on, not the active one', () => {
    // The child binds its client-level listeners (Decrypted/Crypto) to one exact
    // Account. Closing after an account switch must detach from that original client,
    // not whichever account is active now.
    const rootA = fakeEvent({ id: '$a', sender: '@a:hs', body: 'first root' });
    const rootB = fakeEvent({ id: '$b', sender: '@a:hs', body: 'second root' });
    const threads = [
      fakeThread({ id: '$a', rootEvent: rootA, events: [rootA] }),
      fakeThread({ id: '$b', rootEvent: rootB, events: [rootB] }),
    ];
    const room = {
      roomId: '!r:hs',
      getThreads: () => threads,
      getThread: (id: string) => threads.find((t) => t.id === id) ?? null,
      findEventById: (id: string) =>
        [rootA, rootB].find((e) => e.getId() === id),
      getMember: (id: string) => ({
        name: MEMBERS[id] ?? id,
        getMxcAvatarUrl: () => null,
      }),
      getUsersReadUpTo: (): string[] => [],
      relations: { getChildEventsForEvent: () => undefined },
      hasEncryptionStateEvent: () => false,
      ...emitter(),
    };
    const makeClient = () => ({
      getRoom: () => room,
      getUserId: () => '@me:hs',
      sendReadReceipt: () => Promise.resolve({}),
      ...emitter(),
    });
    const clientA = makeClient();
    const clientB = makeClient();
    const active = { client: clientA as unknown };

    TestBed.configureTestingModule({
      providers: [
        ThreadsService,
        switchableMatrixProvider(active),
        MockProvider(MediaService, {
          uploadMedia: fakeMediaService().uploadMedia,
        }),
        {
          provide: CONVERSATION_MESSAGE_ADAPTER,
          useValue: {
            acknowledge: () =>
              of({ kind: 'applied' as const, operation: 'receipt' as const }),
          },
        },
      ],
    });
    const svc = TestBed.inject(ThreadsService);

    svc.attach(
      { accountId: '@me:hs', roomId: '!r:hs' },
      clientA as unknown as MatrixClient,
    );
    svc.attachThreadRoot('$a');
    expect(clientA.listenerCount(MatrixEventEvent.Decrypted)).toBe(2);

    active.client = clientB; // the user switches accounts
    svc.attach(
      { accountId: '@me:hs', roomId: '!r:hs' },
      clientB as unknown as MatrixClient,
    ); // closes the first Account's exact child on the way in
    svc.attachThreadRoot('$b');

    expect(clientA.listenerCount(MatrixEventEvent.Decrypted)).toBe(0);
    expect(clientA.listenerCount(CryptoEvent.UserTrustStatusChanged)).toBe(0);
    expect(clientA.listenerCount(CryptoEvent.DevicesUpdated)).toBe(0);
    expect(clientA.listenerCount(CryptoEvent.KeysChanged)).toBe(0);
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
      out.svc.attachThreadRoot('$root');
      return out;
    }

    it('sends a plain-text message into the thread (thread root as threadId)', async () => {
      const { svc, sent } = openedThread();

      await firstValueFrom(svc.sendToThread('hello thread'));

      // Built content via sendMessage now (so mentions can add m.mentions); the SDK
      // adds the m.thread relation from the threadId, so the message stays in-thread.
      expect(sent[0][0]).toBe('message');
      expect(sent[0][1]).toBe('$root'); // threadId
      // Empty `m.mentions` rides along on every message — see message-content.ts.
      expect(sent[0][2]).toEqual({
        msgtype: 'm.text',
        body: 'hello thread',
        'm.mentions': {},
      });
    });

    it('sends markdown as formatted HTML into the thread', async () => {
      const { svc, sent } = openedThread();

      await firstValueFrom(svc.sendToThread('**bold**'));

      expect(sent[0][0]).toBe('message');
      expect(sent[0][1]).toBe('$root'); // threadId
      const content = sent[0][2] as Record<string, unknown>;
      expect(content['body']).toBe('**bold**');
      expect(content['formatted_body']).toContain('<strong>bold</strong>');
    });

    it('interprets a /me slash command in the thread as an emote', async () => {
      const { svc, sent } = openedThread();

      await firstValueFrom(svc.sendToThread('/me waves'));

      expect(sent[0][0]).toBe('message');
      expect(sent[0][1]).toBe('$root'); // threadId
      expect(sent[0][2]).toMatchObject({ msgtype: 'm.emote', body: 'waves' });
    });

    it('carries @-mentions through a /me sent into a thread', async () => {
      const { svc, sent } = openedThread();

      await firstValueFrom(
        svc.sendToThread('/me waves at @Bob', [
          { userId: '@bob:hs', display: '@Bob' },
        ]),
      );

      const content = sent[0][2] as Record<string, unknown>;
      expect(content['msgtype']).toBe('m.emote');
      expect(content['m.mentions']).toEqual({ user_ids: ['@bob:hs'] });
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

    it('resolves the thread context on subscribe, not when called', async () => {
      // The in-thread actions are cold, so the thread (and the account behind it)
      // must be resolved at subscribe. Capturing the context eagerly means a send
      // built before the user closed the thread still fires into it afterwards.
      const { svc, sent } = openedThread();

      const send$ = svc.sendToThread('hi');
      svc.closeThread();
      await firstValueFrom(send$);

      expect(sent).toHaveLength(0);
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
      svc.attachThreadRoot('$root');
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
      svc.attachThreadRoot('$root');

      expect(svc.canPaginateThread()).toBe(true);
    });

    it('reports nothing older once every reply the server counts is loaded', () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const reply = fakeEvent({
        id: '$r1',
        sender: '@b:hs',
        body: 'only reply',
        ts: 1000,
      });
      const { svc } = setup([
        fakeThread({
          id: '$root',
          rootEvent: root,
          events: [root, reply],
          length: 1,
          paginationToken: 'tok',
        }),
      ]);
      svc.attachThreadRoot('$root');

      expect(svc.canPaginateThread()).toBe(false);
    });

    it('does not count an edit as a reply when deciding whether older replies remain', () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const reply = fakeEvent({
        id: '$r2',
        sender: '@b:hs',
        body: 'reply',
        ts: 2000,
      });
      const edit = fakeEvent({
        id: '$e2',
        sender: '@b:hs',
        body: '* reply',
        ts: 2100,
        editRelation: true,
      });
      const { svc } = setup([
        fakeThread({
          id: '$root',
          rootEvent: root,
          events: [root, reply, edit],
          length: 2,
          paginationToken: 'tok',
        }),
      ]);
      svc.attachThreadRoot('$root');

      expect(svc.canPaginateThread()).toBe(true);
    });

    it('offers no older replies when the server count is zero', () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const { svc } = setup([
        fakeThread({
          id: '$root',
          rootEvent: root,
          events: [root],
          length: 0,
          paginationToken: 'tok',
        }),
      ]);
      svc.attachThreadRoot('$root');

      expect(svc.canPaginateThread()).toBe(false);
    });

    it('keeps the button hidden when a live reply grows the count and is loaded', () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const first = fakeEvent({
        id: '$r1',
        sender: '@b:hs',
        body: 'one',
        ts: 1000,
      });
      const thread = fakeThread({
        id: '$root',
        rootEvent: root,
        events: [root, first],
        length: 1,
        paginationToken: 'tok',
      });
      const { svc } = setup([thread]);
      svc.attachThreadRoot('$root');
      expect(svc.canPaginateThread()).toBe(false);

      thread.events.push(
        fakeEvent({ id: '$r2', sender: '@b:hs', body: 'two', ts: 2000 }),
      );
      thread.length = 2;
      thread.emit(ThreadEvent.NewReply);

      expect(svc.canPaginateThread()).toBe(false);
    });

    it('stops offering older replies when a page returns no events despite the count', async () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const reply = fakeEvent({
        id: '$r1',
        sender: '@b:hs',
        body: 'one',
        ts: 1000,
      });
      // The count includes a reply of a type the client never shows; the token never clears.
      const thread = fakeThread({
        id: '$root',
        rootEvent: root,
        events: [root, reply],
        length: 2,
        paginationToken: 'tok',
      });
      const { svc, client } = setup([thread]);
      stubPaginate(client, () => Promise.resolve(true));
      svc.attachThreadRoot('$root');
      expect(svc.canPaginateThread()).toBe(true);

      await firstValueFrom(svc.paginateOpenThread());
      expect(svc.canPaginateThread()).toBe(false);

      // Sticky: a later live reply refresh does not offer the empty page again.
      thread.emit(ThreadEvent.NewReply);
      expect(svc.canPaginateThread()).toBe(false);
    });

    it('keeps offering older replies after a real page, even though events re-enter the refresh mid-page', async () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const newest = fakeEvent({
        id: '$r3',
        sender: '@b:hs',
        body: 'three',
        ts: 3000,
      });
      const thread = fakeThread({
        id: '$root',
        rootEvent: root,
        events: [root, newest],
        length: 5,
        paginationToken: 'tok',
      });
      const { svc, client } = setup([thread]);
      // Mirror the SDK: each added event emits Timeline (re-emitted by Thread) before the
      // pagination promise resolves, so refreshThread runs with the page already loaded.
      stubPaginate(client, () => {
        for (const n of [2, 1]) {
          thread.events.splice(
            1,
            0,
            fakeEvent({ id: `$r${n}`, sender: '@b:hs', body: `${n}`, ts: n }),
          );
          thread.emit(RoomEvent.Timeline);
        }
        return Promise.resolve(true);
      });
      svc.attachThreadRoot('$root');

      await firstValueFrom(svc.paginateOpenThread());

      expect(svc.threadMessages()).toHaveLength(4);
      expect(svc.canPaginateThread()).toBe(true);
    });

    it('keeps offering older replies when a page returns only edits or reactions', async () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const reply = fakeEvent({
        id: '$r2',
        sender: '@b:hs',
        body: 'two',
        ts: 2000,
      });
      const thread = fakeThread({
        id: '$root',
        rootEvent: root,
        events: [root, reply],
        length: 3,
        paginationToken: 'tok',
      });
      const { svc, client } = setup([thread]);
      stubPaginate(client, () => {
        thread.events.splice(
          1,
          0,
          fakeEvent({ id: '$e1', sender: '@b:hs', editRelation: true }),
        );
        return Promise.resolve(true);
      });
      svc.attachThreadRoot('$root');

      await firstValueFrom(svc.paginateOpenThread());

      expect(svc.canPaginateThread()).toBe(true);
    });

    it('ignores a page that resolves after the user switched to another thread', async () => {
      const rootA = fakeEvent({ id: '$a', sender: '@a:hs', body: 'a' });
      const rootB = fakeEvent({ id: '$b', sender: '@a:hs', body: 'b' });
      const { svc, client } = setup([
        fakeThread({
          id: '$a',
          rootEvent: rootA,
          events: [rootA],
          length: 3,
          paginationToken: 'tok',
        }),
        fakeThread({
          id: '$b',
          rootEvent: rootB,
          events: [rootB],
          length: 3,
          paginationToken: 'tok',
        }),
      ]);
      let finish: (v: boolean) => void = () => undefined;
      stubPaginate(
        client,
        () => new Promise<boolean>((resolve) => (finish = resolve)),
      );
      svc.attachThreadRoot('$a');
      const done = firstValueFrom(svc.paginateOpenThread());

      svc.attachThreadRoot('$b');
      finish(true); // thread A's page returns nothing, after the switch
      await done;

      expect(svc.canPaginateThread()).toBe(true);
    });

    it('keeps offering older replies when a live redaction lowers the count to the loaded replies', () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const redacted = fakeEvent({
        id: '$r2',
        sender: '@b:hs',
        ts: 2000,
        redacted: true,
      });
      const newest = fakeEvent({
        id: '$r3',
        sender: '@b:hs',
        body: 'three',
        ts: 3000,
      });
      // Three replies existed ($r1 older and unloaded); $r2 was redacted live, so the
      // server count dropped to 2 while only one non-redacted reply is loaded.
      const { svc } = setup([
        fakeThread({
          id: '$root',
          rootEvent: root,
          events: [root, redacted, newest],
          length: 2,
          paginationToken: 'tok',
        }),
      ]);
      svc.attachThreadRoot('$root');

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

      svc.attachThreadRoot('$root');
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
      const { svc, room, client } = setup([
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
      svc.close();
      svc.attach(
        { accountId: '@me:hs', roomId: '!r:hs' },
        client as unknown as MatrixClient,
      );

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

      expect(svc.summaries()['$root'].unreadCount).toBe(0);

      total = 4;
      room.emit(RoomEvent.UnreadNotifications);
      expect(svc.summaries()['$root'].unreadCount).toBe(4);
    });

    it('marks the opened thread read through the exact-root message adapter', () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const reply = fakeEvent({
        id: '$r1',
        sender: '@b:hs',
        body: 'reply',
        ts: 1000,
      });
      const { svc, acknowledge } = setup([
        fakeThread({ id: '$root', rootEvent: root, events: [root, reply] }),
      ]);

      svc.attachThreadRoot('$root');

      expect(acknowledge).toHaveBeenCalledWith({
        key: { accountId: '@me:hs', roomId: '!r:hs' },
        messageId: '$r1',
        threadRootId: '$root',
      });
    });

    it('does not acknowledge the same latest thread event twice', () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const reply = fakeEvent({
        id: '$r1',
        sender: '@b:hs',
        body: 'reply',
        ts: 1000,
      });
      const thread = fakeThread({
        id: '$root',
        rootEvent: root,
        events: [root, reply],
      });
      const { svc, room, acknowledge } = setup([thread]);

      svc.attachThreadRoot('$root');
      room.emit(RoomEvent.Receipt);

      expect(acknowledge).toHaveBeenCalledTimes(1);
    });

    it('does not throw when the message adapter rejects the acknowledgement', () => {
      const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root' });
      const { svc, acknowledge } = setup([
        fakeThread({ id: '$root', rootEvent: root, events: [root] }),
      ]);
      acknowledge.mockReturnValue(
        of({
          kind: 'rejected',
          operation: 'receipt',
          failure: 'request-rejected',
          retryable: true,
        }),
      );

      expect(() => svc.attachThreadRoot('$root')).not.toThrow();
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

      const list = svc.threadList();
      expect(list.map((t) => t.rootEventId)).toEqual(['$new', '$old']);
      expect(list[0].latestActivityTs).toBe(900);
      expect(list[0].rootPreview).toBe('new root');
    });
  });
});
