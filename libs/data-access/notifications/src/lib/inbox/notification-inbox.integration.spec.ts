import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  FeatureSupport,
  HTTPError,
  MatrixError,
  MatrixEvent,
  ReceiptType,
  Room,
  SyncState,
  THREAD_RELATION_TYPE,
  Thread,
  ThreadEvent,
  createClient,
  type IEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { defer, firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MentionInboxPreferences } from './mention-inbox.preferences';
import { FakeMentionStore } from './mention-index.spec-harness';
import { MentionIndexService } from './mention-index.service';
import { NotificationInboxService } from './notification-inbox.service';

const ME = '@me:hs';
const ALICE = '@alice:hs';
const ROOM = '!r:hs';

type Raw = Partial<IEvent> & { event_id: string };

const message = (id: string, ts: number, extra: Partial<IEvent> = {}): Raw => ({
  event_id: id,
  room_id: ROOM,
  sender: ALICE,
  type: 'm.room.message',
  origin_server_ts: ts,
  content: { body: 'hello' },
  ...extra,
});

const entry = (event: Raw, read = false) => ({
  event,
  room_id: ROOM,
  read,
  ts: 1,
});

/** A real client and room: the SDK's own mapper, thread and receipt code all run. */
function realClient(rows: readonly unknown[] = []) {
  const client = createClient({
    baseUrl: 'http://127.0.0.1:9',
    userId: ME,
    accessToken: 't',
    deviceId: 'D',
  });
  client.supportsThreads = () => true;
  const answer = vi.fn(() =>
    Promise.resolve({ notifications: rows, chunk: [], state: [], start: 't' }),
  );
  client.http.authedRequest = answer as never;
  vi.spyOn(client, 'getPushActionsForEvent').mockImplementation((event) => ({
    notify: true,
    tweaks: { highlight: String(event.getContent()['body']).includes('@me') },
  }));
  vi.spyOn(client, 'getSyncState').mockReturnValue(SyncState.Syncing);
  vi.spyOn(client, 'getCrypto').mockReturnValue({
    isEncryptionEnabledInRoom: () => Promise.resolve(false),
  } as never);
  const room = new Room(ROOM, client, ME);
  vi.spyOn(room, 'getMyMembership').mockReturnValue('join');
  client.store.storeRoom(room);
  return { client, room };
}

function setup(client: MatrixClient) {
  const store = new FakeMentionStore();
  TestBed.configureTestingModule({
    providers: [
      NotificationInboxService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: client,
        activeUserId: signal<string | null>(ME).asReadonly(),
      }),
      MockProvider(MentionInboxPreferences, {
        recordAllowed: signal(true).asReadonly(),
      }),
      MockProvider(MentionIndexService, {
        page: (accountId, before, limit) =>
          defer(() => store.page(accountId, before, limit, Date.now())),
        forget: (accountId, ids) => defer(() => store.remove(accountId, ids)),
      }),
    ],
  });
  const inbox = TestBed.inject(NotificationInboxService);
  inbox.connect();
  return { inbox, store, open: () => firstValueFrom(inbox.refresh()) };
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve));

const addReceipt = (room: Room, type: ReceiptType, ts: number): void =>
  room.addReceipt(
    new MatrixEvent({
      type: 'm.receipt',
      room_id: ROOM,
      content: { '$elsewhere:hs': { [type]: { [ME]: { ts } } } },
    }),
  );

/** Decrypts by event ID; an ID with no text fails as a missing key would. */
function decryptWith(
  client: MatrixClient,
  texts: Readonly<Record<string, Record<string, unknown>>>,
  hangs?: string,
): void {
  vi.spyOn(client, 'decryptEventIfNeeded').mockImplementation((event) =>
    event.getId() === hangs
      ? new Promise<void>(() => undefined)
      : event.attemptDecryption(
          {
            decryptEvent: () => {
              const content = texts[event.getId() ?? ''];
              return content
                ? Promise.resolve({
                    clearEvent: { type: 'm.room.message', content },
                  })
                : Promise.reject(new Error('no key'));
            },
          } as never,
          { isRetry: true },
        ),
  );
}

const ciphertext = (extra: Record<string, unknown> = {}) => ({
  algorithm: 'm.megolm.v1.aes-sha2',
  ciphertext: 'x',
  ...extra,
});

/** An encrypted original whose bundled edit is encrypted too, as a server sends it. */
const editedOriginal = (): Raw =>
  message('$o', 1, {
    type: 'm.room.encrypted',
    content: ciphertext(),
    unsigned: {
      'm.relations': {
        'm.replace': {
          event_id: '$edit',
          room_id: ROOM,
          sender: ALICE,
          type: 'm.room.encrypted',
          origin_server_ts: 2,
          content: ciphertext({
            'm.relates_to': { rel_type: 'm.replace', event_id: '$o' },
          }),
        },
      },
    } as never,
  });

const EDIT_TEXT = {
  body: '* now',
  'm.new_content': { body: 'now' },
  'm.relates_to': { rel_type: 'm.replace', event_id: '$o' },
};

describe('NotificationInboxService against the real SDK', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Thread.setServerSideSupport(FeatureSupport.None);
  });

  it("does not put a server's redaction on the room's own event", async () => {
    const redacted = message('$e', 1, {
      unsigned: { redacted_because: { event_id: '$r' } } as never,
    });
    const { client, room } = realClient([entry(redacted)]);
    await room.addLiveEvents([new MatrixEvent(message('$e', 1))], {
      addToState: false,
    });
    const { open } = setup(client);

    await open();

    const own = room.findEventById('$e');
    expect(own?.isRedacted()).toBe(false);
    expect(own?.getUnsigned()).not.toHaveProperty('redacted_because');
    client.stopClient();
  });

  describe('a refused index lookup', () => {
    const lookUp = async (error: unknown) => {
      const { client } = realClient();
      vi.spyOn(client, 'fetchRoomEvent').mockRejectedValue(error);
      const { inbox, store, open } = setup(client);
      const ts = Date.now();
      await store.put(ME, { eventId: '$i', roomId: ROOM, ts }, ts);

      await open();
      await flush();

      client.stopClient();
      return { rows: inbox.mentions(), held: store.rows(ME) };
    };

    it.each([
      ['a proxy’s bare 403', new HTTPError('Server returned 403 error', 403)],
      ['a proxy’s bare 404', new HTTPError('Server returned 404 error', 404)],
      [
        'a 403 for a server limit',
        new MatrixError({ errcode: 'M_RESOURCE_LIMIT_EXCEEDED' }, 403),
      ],
      [
        'a 404 from no such route',
        new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 404),
      ],
    ])('keeps the row and the record on %s', async (_name, error) => {
      const { rows, held } = await lookUp(error);

      expect(rows[0]?.preview).toEqual({ kind: 'unavailable' });
      expect(held).toHaveLength(1);
    });

    it.each([
      ['M_FORBIDDEN', 403],
      ['M_NOT_FOUND', 404],
    ])('forgets the record on %s', async (errcode, status) => {
      const { rows, held } = await lookUp(new MatrixError({ errcode }, status));

      expect(rows).toEqual([]);
      expect(held).toEqual([]);
    });
  });

  describe('the unread dot', () => {
    const NOW = Date.now();

    it("uses the room's answer for a loaded event, with a real receipt", async () => {
      const { client, room } = realClient();
      await room.addLiveEvents([new MatrixEvent(message('$loaded', NOW))], {
        addToState: false,
      });
      const hasUserReadEvent = vi.spyOn(room, 'hasUserReadEvent');
      const { inbox, store, open } = setup(client);
      await store.put(ME, { eventId: '$loaded', roomId: ROOM, ts: NOW }, NOW);

      await open();

      expect(hasUserReadEvent).toHaveBeenCalledWith(ME, '$loaded');
      expect(inbox.mentions()[0]?.unread).toBe(true);
      client.stopClient();
    });

    it.each([
      [ReceiptType.Read, 'public'],
      [ReceiptType.ReadPrivate, 'private'],
    ])(
      'compares an unloaded event with the %s receipt, and asks no warning from the room',
      async (type) => {
        const { client, room } = realClient();
        addReceipt(room, type, NOW);
        const hasUserReadEvent = vi.spyOn(room, 'hasUserReadEvent');
        vi.spyOn(client, 'fetchRoomEvent').mockImplementation((_room, id) =>
          Promise.resolve(
            message(id, id === '$before' ? NOW - 1 : NOW + 1) as never,
          ),
        );
        const { inbox, store, open } = setup(client);
        await store.put(
          ME,
          { eventId: '$before', roomId: ROOM, ts: NOW - 1 },
          NOW,
        );
        await store.put(
          ME,
          { eventId: '$after', roomId: ROOM, ts: NOW + 1 },
          NOW,
        );

        await open();

        const unread = (id: string) =>
          inbox.mentions().find((row) => row.eventId === id)?.unread;
        expect(unread('$before')).toBe(false);
        expect(unread('$after')).toBe(true);
        expect(hasUserReadEvent).not.toHaveBeenCalled();
        client.stopClient();
      },
    );

    it('takes the later of the two receipts', async () => {
      const { client, room } = realClient([entry(message('$s', NOW - 1))]);
      addReceipt(room, ReceiptType.Read, NOW - 100);
      addReceipt(room, ReceiptType.ReadPrivate, NOW);
      const { inbox, open } = setup(client);

      await open();

      expect(inbox.all()[0]?.unread).toBe(false);
      client.stopClient();
    });

    it("doesn't trust a server's unread flag once this device has read past it", async () => {
      const { client, room } = realClient([
        entry(message('$stale', NOW - 1), false),
        entry(message('$same', NOW), false),
        entry(message('$unread', NOW + 1), false),
        entry(message('$read', NOW + 2), true),
      ]);
      addReceipt(room, ReceiptType.Read, NOW);
      const { inbox, open } = setup(client);

      await open();

      const unread = (id: string) =>
        inbox.all().find((row) => row.eventId === id)?.unread;
      expect(unread('$stale')).toBe(false);
      expect(unread('$same')).toBe(false);
      expect(unread('$unread')).toBe(true);
      expect(unread('$read')).toBe(false);
      client.stopClient();
    });
  });

  describe('a bundled edit', () => {
    it('previews the edit, and judges the mention on its text', async () => {
      const { client } = realClient([entry(editedOriginal())]);
      decryptWith(client, {
        $o: { body: 'before' },
        $edit: {
          ...EDIT_TEXT,
          'm.new_content': { body: 'now @me' },
        },
      });
      const { inbox, open } = setup(client);

      await open();

      expect(inbox.mentions()[0]?.preview).toEqual({
        kind: 'text',
        text: 'now @me',
      });
      client.stopClient();
    });

    it("doesn't preview the original's text when the edit has no key", async () => {
      const { client } = realClient([entry(editedOriginal())]);
      decryptWith(client, { $o: { body: 'edited out' } });
      const { inbox, open } = setup(client);

      await open();

      const row = inbox.all()[0];
      expect(row?.preview).toEqual({ kind: 'unavailable' });
      expect(JSON.stringify(row)).not.toContain('edited out');
      expect(inbox.uncheckedCount()).toBe(1);
      client.stopClient();
    });

    it("doesn't preview the original's text when the edit's decrypt hangs", async () => {
      vi.useFakeTimers();
      const { client } = realClient([entry(editedOriginal())]);
      decryptWith(client, { $o: { body: 'edited out' } }, '$edit');
      const { inbox } = setup(client);

      const done = firstValueFrom(inbox.refresh());
      await vi.advanceTimersByTimeAsync(10_000);
      await done;

      expect(inbox.all()[0]?.preview).toEqual({ kind: 'unavailable' });
      client.stopClient();
    });
  });

  // A function: the name depends on `Thread.setServerSideSupport`, which each test sets.
  const threadRelation = () => ({
    rel_type: THREAD_RELATION_TYPE.name,
    event_id: '$root',
  });

  it('keeps the thread of a copy only the room places in one', async () => {
    Thread.setServerSideSupport(FeatureSupport.Stable);
    const edit = message('$edit-of-known', 5, {
      content: {
        body: '* hi',
        'm.new_content': { body: 'hi' },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$known' },
      },
    });
    const { client, room } = realClient([entry(edit)]);
    await room.addLiveEvents(
      [
        new MatrixEvent(message('$root', 1)),
        new MatrixEvent(
          message('$known', 2, {
            content: { body: 'hi', 'm.relates_to': threadRelation() },
          }),
        ),
      ],
      { addToState: false },
    );
    await flush();
    // The room's own answer for an edit of a threaded message, whatever the stub's replies loaded.
    vi.spyOn(room, 'findThreadForEvent').mockReturnValue(
      room.getThread('$root'),
    );
    const { inbox, open } = setup(client);

    await open();

    expect(inbox.all()[0]?.threadRootId).toBe('$root');
    client.stopClient();
  });

  it("leaves no listener from a bundled edit's copy", async () => {
    Thread.setServerSideSupport(FeatureSupport.Stable);
    // A server may name the thread in `unsigned`, which is how an edit's copy finds one.
    const edit = {
      event_id: '$copy',
      room_id: ROOM,
      sender: ALICE,
      type: 'm.room.message',
      origin_server_ts: 6,
      unsigned: { 'org.matrix.msc4023.thread_id': '$root' },
      content: {
        body: '* hi',
        'm.new_content': { body: 'hi' },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$o' },
      },
    };
    const { client, room } = realClient([
      entry(
        message('$o', 5, {
          unsigned: { 'm.relations': { 'm.replace': edit } } as never,
        }),
      ),
    ]);
    await room.addLiveEvents(
      [
        new MatrixEvent(message('$root', 1)),
        new MatrixEvent(
          message('$known', 2, {
            content: { body: 'hi', 'm.relates_to': threadRelation() },
          }),
        ),
      ],
      { addToState: false },
    );
    await flush();
    const thread = room.getThread('$root');
    expect(thread).toBeTruthy();
    const before = thread?.listenerCount(ThreadEvent.Update);
    const { open } = setup(client);

    await open();

    expect(thread?.listenerCount(ThreadEvent.Update)).toBe(before);
    client.stopClient();
  });

  it('leaves the thread on an edit the room itself holds', async () => {
    Thread.setServerSideSupport(FeatureSupport.Stable);
    const { client, room } = realClient();
    const held = new MatrixEvent(
      message('$held-edit', 6, {
        content: {
          body: '* hi',
          'm.new_content': { body: 'hi' },
          'm.relates_to': { rel_type: 'm.replace', event_id: '$o' },
        },
      }),
    );
    vi.spyOn(room, 'findEventById').mockImplementation((id) =>
      id === '$held-edit' ? held : undefined,
    );
    const thread = { id: '$root' } as Thread;
    Object.assign(held, { thread });
    // Only the release under test reads this: the mapper finds no thread for an unloaded parent.
    const setThread = vi.spyOn(held, 'setThread').mockReturnValue();
    client.http.authedRequest = vi.fn(() =>
      Promise.resolve({
        notifications: [
          entry(
            message('$o', 5, {
              unsigned: {
                'm.relations': { 'm.replace': held.event },
              } as never,
            }),
          ),
        ],
      }),
    ) as never;
    const { open } = setup(client);

    await open();

    expect(setThread).not.toHaveBeenCalledWith(undefined);
    client.stopClient();
  });

  it('leaves no listener on a thread from the copies it maps', async () => {
    Thread.setServerSideSupport(FeatureSupport.Stable);
    const inThread = (id: string): Raw =>
      message(id, 5, {
        content: {
          body: 'hi',
          'm.relates_to': {
            rel_type: THREAD_RELATION_TYPE.name,
            event_id: '$root',
          },
        },
      });
    const { client, room } = realClient(
      ['$a', '$b', '$c'].map((id) => entry(inThread(id))),
    );
    await room.addLiveEvents(
      [
        new MatrixEvent(message('$root', 1)),
        new MatrixEvent(inThread('$known')),
      ],
      { addToState: false },
    );
    await flush();
    const thread = room.getThread('$root');
    expect(thread).toBeTruthy();
    const before = thread?.listenerCount(ThreadEvent.Update);
    const { inbox, open } = setup(client);

    await open();

    expect(thread?.listenerCount(ThreadEvent.Update)).toBe(before);
    expect(inbox.all().map((row) => row.threadRootId)).toEqual([
      '$root',
      '$root',
      '$root',
    ]);
    client.stopClient();
  });
});
