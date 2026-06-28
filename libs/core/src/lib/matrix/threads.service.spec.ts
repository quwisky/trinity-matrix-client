import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ThreadsService } from './threads.service';
import { MatrixClientService } from './matrix-client.service';

const MEMBERS: Record<string, string> = {
  '@me:hs': 'Me',
  '@a:hs': 'Alice',
  '@b:hs': 'Bob',
};

function fakeEvent(o: {
  id: string;
  sender: string;
  body?: string;
  ts?: number;
  type?: string;
  redacted?: boolean;
  decryptFail?: boolean;
  replyTo?: string;
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
    status: null,
  };
}

type FakeEvent = ReturnType<typeof fakeEvent>;

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
    on: () => undefined,
    off: () => undefined,
  };
}

type FakeThread = ReturnType<typeof fakeThread>;

function setup(threads: FakeThread[]) {
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
    relations: { getChildEventsForEvent: () => undefined },
    on: () => undefined,
    off: () => undefined,
  };
  const client = {
    getRoom: () => room,
    getUserId: () => '@me:hs',
    on: () => undefined,
    off: () => undefined,
  };
  const matrix = {
    isInitialized: true,
    instance: client,
  } as unknown as MatrixClientService;
  TestBed.configureTestingModule({
    providers: [
      ThreadsService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  return TestBed.inject(ThreadsService);
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
    const svc = setup([
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
    const svc = setup([
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
    const svc = setup([
      // events lacks the root — it should still appear first.
      fakeThread({ id: '$root', rootEvent: root, events: [reply] }),
    ]);
    svc.openThread('!r:hs', '$root');

    expect(svc.threadMessages().map((m) => m.id)).toEqual(['$root', '$r1']);
  });

  it('renders the unable-to-decrypt fallback for an E2EE failure in a thread', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const failed = fakeEvent({ id: '$f', sender: '@b:hs', decryptFail: true });
    const svc = setup([
      fakeThread({ id: '$root', rootEvent: root, events: [root, failed] }),
    ]);
    svc.openThread('!r:hs', '$root');

    const failedView = svc.threadMessages().find((m) => m.id === '$f');
    expect(failedView?.decryptionFailed).toBe(true);
    expect(failedView?.body).toContain('Unable to decrypt');
  });

  it('clears state on close / closeThread', () => {
    const root = fakeEvent({ id: '$root', sender: '@a:hs', body: 'root msg' });
    const svc = setup([
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
});
