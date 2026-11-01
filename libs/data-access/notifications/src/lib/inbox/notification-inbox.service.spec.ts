import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MatrixEvent, SyncState, type MatrixClient } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { NEVER, defer, firstValueFrom, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_TEXT } from '../notification-text.port';
import type { InboxRow } from './inbox-rows';
import { MentionInboxPreferences } from './mention-inbox.preferences';
import { FakeMentionStore } from './mention-index.spec-harness';
import { MentionIndexService } from './mention-index.service';
import { NotificationInboxService } from './notification-inbox.service';

const ME = '@me:hs';
const ALICE = '@alice:hs';
const ROOM = '!r:hs';
const NEVER_RESOLVES = new Promise<void>(() => undefined);

type Raw = Record<string, unknown>;

const message = (
  id: string,
  ts: number,
  body = 'hello',
  extra: Raw = {},
): Raw => ({
  event_id: id,
  room_id: ROOM,
  sender: ALICE,
  type: 'm.room.message',
  origin_server_ts: ts,
  content: { body },
  ...extra,
});

const encrypted = (id: string, ts: number, extra: Raw = {}): Raw =>
  message(id, ts, '', {
    type: 'm.room.encrypted',
    content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' },
    ...extra,
  });

const entry = (event: Raw, read = false, roomId = ROOM): Raw => ({
  event,
  room_id: roomId,
  read,
  ts: 1,
});

function fakeRoom(overrides: Raw = {}) {
  return {
    roomId: ROOM,
    name: 'Team',
    getMyMembership: () => 'join',
    getMember: (id: string) => (id === ALICE ? { name: 'Alice' } : null),
    hasEncryptionStateEvent: () => false,
    hasUserReadEvent: vi.fn(() => false),
    findEventById: vi.fn((): MatrixEvent | undefined => undefined),
    ...overrides,
  };
}

/** Server pages keyed by their `from` token; `null` is the first page. */
type Pages = Record<string, { rows: readonly Raw[]; next?: string }>;

const FIRST = 'first';

function fakeClient(pages: Pages = { [FIRST]: { rows: [] } }, userId = ME) {
  const events = new Map<string, Raw>();
  const client = {
    pages,
    room: fakeRoom() as ReturnType<typeof fakeRoom> | null,
    syncState: SyncState.Syncing as SyncState | null,
    syncData: {} as { fromCache?: boolean },
    crypto: {
      isEncryptionEnabledInRoom: vi.fn(() => Promise.resolve(false)),
    } as { isEncryptionEnabledInRoom: ReturnType<typeof vi.fn> } | null,
    ignored: new Set<string>(),
    events,
    paginateEventTimeline: vi.fn(),
    getNotifTimelineSet: vi.fn(),
    getUserId: () => userId,
    getRoom: vi.fn((): unknown => client.room),
    getSyncState: () => client.syncState,
    getSyncStateData: () => client.syncData,
    getCrypto: () => client.crypto,
    isUserIgnored: (id: string) => client.ignored.has(id),
    getEventMapper: vi.fn(() => (raw: object) => new MatrixEvent(raw as never)),
    decryptEventIfNeeded: vi.fn((event: MatrixEvent) =>
      decrypted(event, 'hi @me'),
    ),
    getPushActionsForEvent: vi.fn((event: MatrixEvent) => ({
      tweaks: {
        highlight: String(event.getContent()['body']).includes('@me'),
      },
    })),
    fetchRoomEvent: vi.fn((_room: string, id: string): Promise<Raw> =>
      events.has(id)
        ? Promise.resolve(events.get(id) as Raw)
        : Promise.reject(Object.assign(new Error('x'), { httpStatus: 404 })),
    ),
    http: {
      authedRequest: vi.fn(
        (_method: string, _path: string, params: Record<string, string>) => {
          const page = client.pages[params['from'] ?? FIRST];
          return Promise.resolve({
            notifications: page?.rows ?? [],
            next_token: page?.next,
          });
        },
      ),
    },
  };
  return client;
}

type FakeClient = ReturnType<typeof fakeClient>;

function decrypted(event: MatrixEvent, body: string): Promise<void> {
  return event.attemptDecryption(
    {
      decryptEvent: () =>
        Promise.resolve({
          clearEvent: { type: 'm.room.message', content: { body } },
        }),
    } as never,
    { isRetry: true },
  );
}

function setup(
  options: {
    client?: FakeClient;
    mode?: () => 'show' | 'hide-on-lock-screen' | 'always-hide';
    index?: Partial<MentionIndexService>;
    recordAllowed?: boolean;
  } = {},
) {
  let active = options.client ?? fakeClient();
  const activeUserId = signal<string | null>(active.getUserId());
  const store = new FakeMentionStore();
  const remove = vi.spyOn(store, 'remove');
  const recordAllowed = signal(options.recordAllowed ?? true);
  TestBed.configureTestingModule({
    providers: [
      NotificationInboxService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        get instance() {
          return active as unknown as MatrixClient;
        },
        activeUserId: activeUserId.asReadonly(),
      }),
      MockProvider(MentionInboxPreferences, {
        recordAllowed: recordAllowed.asReadonly(),
      }),
      MockProvider(MentionIndexService, {
        page: (accountId, before, limit) =>
          defer(() => store.page(accountId, before, limit, Date.now())),
        forget: (accountId, ids) => defer(() => store.remove(accountId, ids)),
        ...options.index,
      }),
      options.mode
        ? { provide: NOTIFICATION_TEXT, useValue: { mode: options.mode } }
        : [],
    ],
  });
  const inbox = TestBed.inject(NotificationInboxService);
  inbox.connect();
  return {
    inbox,
    store,
    remove,
    recordAllowed,
    client: active,
    switchTo: (next: FakeClient): void => {
      active = next;
      activeUserId.set(next.getUserId());
      TestBed.tick();
    },
    open: () => firstValueFrom(inbox.refresh()),
  };
}

const ids = (rows: readonly InboxRow[]): readonly string[] =>
  rows.map((row) => row.eventId);

async function flush(): Promise<void> {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await new Promise((resolve) => setTimeout(resolve));
  }
}

/** A long server list of plain rows, in pages of 50 linked by `t1`, `t2`, …. */
function longList(mentionAt?: number): Pages {
  const pages: Pages = {};
  for (let n = 0; n < 20; n++) {
    const rows = Array.from({ length: 50 }, (_, i) => {
      const at = n * 50 + i;
      return entry(
        message(`$e${at}`, 100_000 - at, at === mentionAt ? 'hi @me' : 'plain'),
      );
    });
    pages[n === 0 ? FIRST : `t${n}`] = { rows, next: `t${n + 1}` };
  }
  return pages;
}

const requests = (client: FakeClient): readonly Record<string, string>[] =>
  client.http.authedRequest.mock.calls.map(([, , params]) => params);

describe('NotificationInboxService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('paging', () => {
    it('Load more stops after 3 pages of 50 and says so', async () => {
      const client = fakeClient(longList());
      const { inbox, open } = setup({ client });
      await open();
      client.http.authedRequest.mockClear();

      await firstValueFrom(inbox.loadMore('mentions'));

      expect(requests(client)).toEqual([
        { limit: '50', from: 't1' },
        { limit: '50', from: 't2' },
        { limit: '50', from: 't3' },
      ]);
      expect(inbox.lastLoad()).toEqual({ kind: 'limit', checked: 150 });
      expect(inbox.hasMore()).toBe(true);

      client.http.authedRequest.mockClear();
      await firstValueFrom(inbox.loadMore('mentions'));
      expect(requests(client)[0]).toEqual({ limit: '50', from: 't4' });
    });

    it('Load more stops early once a page finds a mention', async () => {
      const client = fakeClient(longList(120));
      const { inbox, open } = setup({ client });
      await open();
      client.http.authedRequest.mockClear();

      await firstValueFrom(inbox.loadMore('mentions'));

      expect(client.http.authedRequest).toHaveBeenCalledTimes(2);
      expect(inbox.lastLoad()).toEqual({ kind: 'found' });
      expect(ids(inbox.mentions())).toEqual(['$e120']);
    });

    it('Load more on All takes one page', async () => {
      const client = fakeClient(longList());
      const { inbox, open } = setup({ client });
      await open();
      client.http.authedRequest.mockClear();

      await firstValueFrom(inbox.loadMore('all'));

      expect(client.http.authedRequest).toHaveBeenCalledTimes(1);
      expect(inbox.lastLoad()).toEqual({ kind: 'found' });
      expect(inbox.all()).toHaveLength(100);
    });

    it('Load more on All takes one page even when it adds no row', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$a', 9))], next: 't1' },
        t1: {
          rows: [
            entry(
              message('$r', 8, 'x', {
                unsigned: { redacted_because: { event_id: '$x' } },
              }),
            ),
          ],
          next: 't2',
        },
      });
      const { inbox, open } = setup({ client });
      await open();
      client.http.authedRequest.mockClear();

      await firstValueFrom(inbox.loadMore('all'));

      expect(client.http.authedRequest).toHaveBeenCalledTimes(1);
      expect(inbox.lastLoad()).toEqual({ kind: 'limit', checked: 1 });
    });

    it('clears the last result when the next load starts', async () => {
      const { inbox, open } = setup({ client: fakeClient(longList()) });
      await open();
      await firstValueFrom(inbox.loadMore('mentions'));
      expect(inbox.lastLoad()).not.toBeNull();

      await open();

      expect(inbox.lastLoad()).toBeNull();
    });

    it('does nothing on Load more before the inbox has opened', async () => {
      const { inbox, client } = setup();

      await firstValueFrom(inbox.loadMore('mentions'));

      expect(client.http.authedRequest).not.toHaveBeenCalled();
      expect(inbox.lastLoad()).toBeNull();
      expect(inbox.status()).toBe('idle');
    });

    it('has no more index rows after a short page', async () => {
      const client = fakeClient();
      client.events.set('$i', message('$i', 1));
      const { inbox, store, open } = setup({ client });
      await store.put(ME, { eventId: '$i', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();

      expect(inbox.mentions()).toHaveLength(1);
      expect(inbox.hasMore()).toBe(false);
    });

    it('answers with the status already settled', () => {
      const { inbox } = setup();
      return new Promise<void>((resolve) => {
        inbox.refresh().subscribe(() => {
          expect(inbox.status()).toBe('ready');
          resolve();
        });
      });
    });

    it('reports the end when the server has no next_token', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$a', 3))], next: 't1' },
        t1: { rows: [entry(message('$b', 2))] },
      });
      const { inbox, open } = setup({ client });
      await open();
      expect(inbox.hasMore()).toBe(true);

      await firstValueFrom(inbox.loadMore('mentions'));

      expect(client.http.authedRequest).toHaveBeenCalledTimes(2);
      expect(inbox.lastLoad()).toEqual({ kind: 'end' });
      expect(inbox.hasMore()).toBe(false);
    });

    it('opening fetches one server page', async () => {
      const client = fakeClient(longList());
      const { inbox, open } = setup({ client });
      expect(inbox.status()).toBe('idle');

      await open();

      expect(requests(client)).toEqual([{ limit: '50' }]);
      expect(inbox.status()).toBe('ready');
      expect(inbox.lastLoad()).toBeNull();
    });

    it('pages the index along with the server on Mentions only', async () => {
      const client = fakeClient(longList());
      const { inbox, store, open } = setup({ client });
      for (let i = 0; i < 60; i++) {
        client.events.set(`$i${i}`, message(`$i${i}`, 5000 - i));
        await store.put(
          ME,
          { eventId: `$i${i}`, roomId: ROOM, ts: Date.now() - i },
          Date.now(),
        );
      }
      await open();
      expect(inbox.mentions()).toHaveLength(50);

      await firstValueFrom(inbox.loadMore('all'));
      expect(inbox.mentions()).toHaveLength(50);

      await firstValueFrom(inbox.loadMore('mentions'));
      expect(inbox.mentions()).toHaveLength(60);
      expect(inbox.lastLoad()).toEqual({ kind: 'found' });
    });

    it('tells whether the server alone has more, for All', async () => {
      const client = fakeClient();
      const { inbox, store, open } = setup({ client });
      for (let i = 0; i < 50; i++) {
        client.events.set(`$i${i}`, message(`$i${i}`, 5000 - i));
        await store.put(
          ME,
          { eventId: `$i${i}`, roomId: ROOM, ts: Date.now() - i },
          Date.now(),
        );
      }
      await open();
      expect(inbox.hasMore()).toBe(true);
      expect(inbox.serverHasMore()).toBe(false);

      await firstValueFrom(inbox.loadMore('all'));
      expect(inbox.lastLoad()).toEqual({ kind: 'end' });
      expect(client.http.authedRequest).toHaveBeenCalledTimes(1);
    });

    it('runs at most 4 decryptions at a time, across both sources', async () => {
      const rows = Array.from({ length: 50 }, (_, i) =>
        entry(encrypted(`$e${i}`, 1000 - i)),
      );
      const client = fakeClient({ [FIRST]: { rows } });
      let active = 0;
      let peak = 0;
      const waiting: (() => void)[] = [];
      client.decryptEventIfNeeded.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            peak = Math.max(peak, ++active);
            waiting.push(() => {
              active--;
              resolve();
            });
          }),
      );
      const { inbox, store } = setup({ client });
      for (let i = 0; i < 50; i++) {
        client.events.set(`$i${i}`, encrypted(`$i${i}`, 500 - i));
        await store.put(
          ME,
          { eventId: `$i${i}`, roomId: ROOM, ts: Date.now() - i },
          Date.now(),
        );
      }

      const done = firstValueFrom(inbox.refresh());
      for (let i = 0; i < 100; i++) {
        await flush();
        waiting.splice(0).forEach((release) => release());
      }
      await done;

      expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(100);
      expect(peak).toBe(4);
    });

    it('ignores Load more while a load runs', async () => {
      const client = fakeClient(longList());
      const { inbox, open } = setup({ client });
      await open();
      client.http.authedRequest.mockClear();

      const refreshing = firstValueFrom(inbox.refresh());
      await firstValueFrom(inbox.loadMore('mentions'));
      await refreshing;

      expect(requests(client)).toEqual([{ limit: '50' }]);
      expect(inbox.all()).toHaveLength(50);
    });

    it('stops starting decryptions when unsubscribed, and stops loading', async () => {
      const rows = Array.from({ length: 50 }, (_, i) =>
        entry(encrypted(`$e${i}`, 1000 - i)),
      );
      const client = fakeClient({ [FIRST]: { rows } });
      client.decryptEventIfNeeded.mockImplementation(() => NEVER_RESOLVES);
      const { inbox } = setup({ client });

      const subscription = inbox.refresh().subscribe();
      await flush();
      expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(4);
      subscription.unsubscribe();
      await flush();

      expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(4);
      expect(inbox.status()).toBe('ready');
    });
  });

  describe('merge and tabs', () => {
    it('merges by event ID, newest first by origin_server_ts', async () => {
      const client = fakeClient({
        [FIRST]: {
          rows: [
            // The entry's `ts` is the server's receive time, and must not order the rows.
            { ...entry(message('$old', 10, 'hi @me')), ts: 9000 },
            entry(message('$both', 30, 'hi @me')),
          ],
        },
      });
      const { inbox, store, open } = setup({ client });
      const now = Date.now();
      client.events.set('$idx', message('$idx', now));
      client.events.set('$both', message('$both', now - 5, 'hi @me'));
      await store.put(ME, { eventId: '$idx', roomId: ROOM, ts: now }, now);
      await store.put(ME, { eventId: '$both', roomId: ROOM, ts: 30 }, now);

      await open();

      expect(ids(inbox.mentions())).toEqual(['$idx', '$both', '$old']);
      expect(inbox.mentions().map((row) => row.ts)).toEqual([now, 30, 10]);
    });

    it('Mentions holds re-checked server rows and index rows; All holds only server rows', async () => {
      const client = fakeClient({
        [FIRST]: {
          rows: [
            entry(message('$plain', 3)),
            entry(message('$mention', 2, 'hi @me')),
          ],
        },
      });
      const { inbox, store, open } = setup({ client });
      client.events.set('$idx', message('$idx', 1));
      await store.put(ME, { eventId: '$idx', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();

      expect(ids(inbox.mentions())).toEqual(['$mention', '$idx']);
      expect(ids(inbox.all())).toEqual(['$plain', '$mention']);
    });

    it('keeps an index row the rules no longer highlight: it was judged when recorded', async () => {
      const { inbox, store, client, open } = setup();
      client.events.set('$idx', message('$idx', 1, 'no mention now'));
      await store.put(ME, { eventId: '$idx', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();

      expect(ids(inbox.mentions())).toEqual(['$idx']);
    });

    it('finds an encrypted mention the server did not highlight', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(encrypted('$e', 1))] },
      });
      const { inbox, open } = setup({ client });

      await open();

      expect(ids(inbox.mentions())).toEqual(['$e']);
      expect(inbox.mentions()[0]?.preview).toEqual({
        kind: 'text',
        text: 'hi @me',
      });
    });

    it('counts an undecryptable server row and does not guess', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(encrypted('$e', 1))] },
      });
      client.decryptEventIfNeeded.mockRejectedValue(new Error('no key'));
      const { inbox, open } = setup({ client });

      await open();

      expect(inbox.uncheckedCount()).toBe(1);
      expect(inbox.mentions()).toEqual([]);
      expect(inbox.all()[0]?.preview).toEqual({ kind: 'encrypted' });
    });

    it('does not count one the index already holds', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(encrypted('$e', 1))] },
      });
      client.decryptEventIfNeeded.mockRejectedValue(new Error('no key'));
      client.events.set('$e', encrypted('$e', 1));
      const { inbox, store, open } = setup({ client });
      await store.put(ME, { eventId: '$e', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();

      expect(inbox.uncheckedCount()).toBe(0);
      expect(ids(inbox.mentions())).toEqual(['$e']);
    });

    it('keeps an undecryptable index row as a row', async () => {
      const client = fakeClient();
      client.decryptEventIfNeeded.mockRejectedValue(new Error('no key'));
      client.events.set('$e', encrypted('$e', 1));
      const { inbox, store, remove, open } = setup({ client });
      await store.put(ME, { eventId: '$e', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();

      expect(inbox.mentions()[0]?.preview).toEqual({ kind: 'encrypted' });
      expect(inbox.uncheckedCount()).toBe(0);
      expect(remove).not.toHaveBeenCalled();
    });

    it('shows rows as undecryptable when crypto is not ready, until the next refresh', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(encrypted('$e', 1))] },
      });
      const crypto = client.crypto;
      client.crypto = null;
      const { inbox, open } = setup({ client });

      await open();
      expect(inbox.all()[0]?.preview).toEqual({ kind: 'encrypted' });
      expect(inbox.uncheckedCount()).toBe(1);

      client.crypto = crypto;
      await open();
      expect(inbox.all()[0]?.preview).toEqual({ kind: 'text', text: 'hi @me' });
      expect(inbox.uncheckedCount()).toBe(0);
    });

    it('uses only the server list with the record off', async () => {
      const client = fakeClient({
        [FIRST]: {
          rows: [
            entry(
              message('$r', 2, 'x', { unsigned: { redacted_because: {} } }),
            ),
          ],
        },
      });
      const page = vi.fn(() => NEVER);
      const forget = vi.fn(() => NEVER);
      const { inbox, open } = setup({
        client,
        recordAllowed: false,
        index: { page, forget },
      });

      await open();

      expect(inbox.status()).toBe('ready');
      expect(page).not.toHaveBeenCalled();
      expect(forget).not.toHaveBeenCalled();
    });
  });

  describe('dropped rows', () => {
    const redacted = (id: string): Raw =>
      message(id, 1, 'gone', {
        unsigned: { redacted_because: { event_id: '$r' } },
      });

    it('removes a redacted event from the list and the index', async () => {
      const client = fakeClient({ [FIRST]: { rows: [entry(redacted('$s'))] } });
      client.events.set('$i', redacted('$i'));
      const { inbox, store, remove, open } = setup({ client });
      await store.put(ME, { eventId: '$i', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();
      await flush();

      expect(inbox.all()).toEqual([]);
      expect(inbox.mentions()).toEqual([]);
      expect(remove).toHaveBeenCalledWith(ME, ['$s']);
      expect(remove).toHaveBeenCalledWith(ME, ['$i']);
      expect(store.rows(ME)).toEqual([]);
    });

    it('removes a row for a room the person left, once synced', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$s', 2))] },
      });
      client.room = fakeRoom({ getMyMembership: () => 'leave' });
      client.events.set('$i', message('$i', 1));
      const { inbox, store, open } = setup({ client });
      await store.put(ME, { eventId: '$i', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();
      await flush();

      expect(inbox.all()).toEqual([]);
      expect(inbox.mentions()).toEqual([]);
      expect(store.rows(ME)).toEqual([]);
      expect(client.fetchRoomEvent).not.toHaveBeenCalled();
    });

    it('removes a row for a room no longer known, once synced', async () => {
      const client = fakeClient();
      client.room = null;
      const { inbox, store, open } = setup({ client });
      await store.put(ME, { eventId: '$i', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();
      await flush();

      expect(inbox.mentions()).toEqual([]);
      expect(store.rows(ME)).toEqual([]);
    });

    it.each([403, 404])('removes a row on %i', async (httpStatus) => {
      const client = fakeClient();
      client.fetchRoomEvent.mockRejectedValue(
        Object.assign(new Error('x'), { httpStatus }),
      );
      const { inbox, store, open } = setup({ client });
      await store.put(ME, { eventId: '$i', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();
      await flush();

      expect(inbox.mentions()).toEqual([]);
      expect(store.rows(ME)).toEqual([]);
    });

    it('keeps a row on a network error, preview unavailable, index untouched', async () => {
      const client = fakeClient();
      client.fetchRoomEvent.mockRejectedValue(new Error('offline'));
      const { inbox, store, remove, open } = setup({ client });
      await store.put(ME, { eventId: '$i', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();
      await flush();

      expect(inbox.mentions()).toEqual([
        expect.objectContaining({
          eventId: '$i',
          ts: 1,
          roomName: 'Team',
          senderName: null,
          preview: { kind: 'unavailable' },
        }),
      ]);
      expect(remove).not.toHaveBeenCalled();
    });

    it('deletes nothing before the account has synced', async () => {
      const client = fakeClient();
      client.syncState = SyncState.Prepared;
      client.syncData = { fromCache: true };
      client.room = null;
      const { inbox, store, remove, open } = setup({ client });
      await store.put(ME, { eventId: '$i', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();
      await flush();

      expect(inbox.mentions()).toEqual([
        expect.objectContaining({
          eventId: '$i',
          roomName: ROOM,
          preview: { kind: 'unavailable' },
        }),
      ]);
      expect(remove).not.toHaveBeenCalled();
    });

    it('previews nothing without a room to judge it by, before the account has synced', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$s', 2))] },
      });
      client.syncState = null;
      client.room = null;
      const { inbox, open } = setup({ client });

      await open();

      expect(inbox.all()[0]?.preview).toEqual({ kind: 'unavailable' });
      expect(inbox.all()[0]?.senderName).toBe(ALICE);
    });

    it('keeps a redacted row without deleting it, before the account has synced', async () => {
      const client = fakeClient({ [FIRST]: { rows: [entry(redacted('$s'))] } });
      client.syncState = SyncState.Prepared;
      client.syncData = { fromCache: true };
      const { inbox, remove, open } = setup({ client });

      await open();
      await flush();

      expect(inbox.all()[0]?.preview).toEqual({ kind: 'unavailable' });
      expect(remove).not.toHaveBeenCalled();
    });

    it('never lets a forget that does not answer hold the view up', async () => {
      const client = fakeClient({ [FIRST]: { rows: [entry(redacted('$s'))] } });
      const forget = vi.fn(() => NEVER);
      const { inbox, open } = setup({ client, index: { forget } });

      await open();

      expect(forget).toHaveBeenCalledOnce();
      expect(inbox.status()).toBe('ready');
    });

    it('survives a forget that fails', async () => {
      const client = fakeClient({ [FIRST]: { rows: [entry(redacted('$s'))] } });
      const { inbox, open } = setup({
        client,
        index: { forget: () => throwError(() => new Error('quota')) },
      });

      await open();

      expect(inbox.status()).toBe('ready');
    });
  });

  describe('failures', () => {
    it('shows index rows with serverListFailed when the server fails', async () => {
      const client = fakeClient();
      client.http.authedRequest.mockRejectedValue(new Error('500'));
      client.events.set('$i', message('$i', 1));
      const { inbox, store, open } = setup({ client });
      await store.put(ME, { eventId: '$i', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();

      expect(ids(inbox.mentions())).toEqual(['$i']);
      expect(inbox.serverListFailed()).toBe(true);
      expect(inbox.status()).toBe('ready');
    });

    it('reads failed with nothing to show', async () => {
      const client = fakeClient();
      client.http.authedRequest.mockRejectedValue(new Error('500'));
      const { inbox, open } = setup({ client });

      await open();

      expect(inbox.status()).toBe('failed');
      expect(inbox.hasMore()).toBe(false);
    });

    it('recovers on the next refresh', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$s', 1))] },
      });
      client.http.authedRequest.mockRejectedValueOnce(new Error('500'));
      const { inbox, open } = setup({ client });

      await open();
      expect(inbox.status()).toBe('failed');

      await open();
      expect(inbox.status()).toBe('ready');
      expect(inbox.serverListFailed()).toBe(false);
    });

    it('stays on the same page when Load more fails, and says nothing about it', async () => {
      const client = fakeClient(longList());
      const { inbox, open } = setup({ client });
      await open();
      client.http.authedRequest.mockRejectedValueOnce(new Error('500'));

      await firstValueFrom(inbox.loadMore('mentions'));

      expect(inbox.lastLoad()).toBeNull();
      expect(inbox.serverListFailed()).toBe(true);
      expect(inbox.status()).toBe('ready');
      expect(inbox.all()).toHaveLength(50);
      expect(client.http.authedRequest).toHaveBeenCalledTimes(2);

      await firstValueFrom(inbox.loadMore('mentions'));
      expect(client.http.authedRequest.mock.calls[2]?.[2]).toEqual({
        limit: '50',
        from: 't1',
      });
    });

    it('falls back to the server list when the store fails', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$s', 1, 'hi @me'))] },
      });
      const { inbox, store, open } = setup({ client });
      store.failReads();

      await open();

      expect(ids(inbox.mentions())).toEqual(['$s']);
      expect(inbox.status()).toBe('ready');
      expect(inbox.serverListFailed()).toBe(false);
      expect(inbox.hasMore()).toBe(false);
    });

    it('stops paging the index when a later read fails, and keeps its rows', async () => {
      const client = fakeClient();
      const { inbox, store, open } = setup({ client });
      for (let i = 0; i < 50; i++) {
        client.events.set(`$i${i}`, message(`$i${i}`, 5000 - i));
        await store.put(
          ME,
          { eventId: `$i${i}`, roomId: ROOM, ts: 5000 - i },
          5000,
        );
      }
      vi.spyOn(Date, 'now').mockReturnValue(6000);
      await open();
      expect(inbox.hasMore()).toBe(true);

      store.failReads();
      await open();

      expect(inbox.hasMore()).toBe(false);
      expect(inbox.mentions()).toHaveLength(50);
    });

    it('reads an index page that never answers as a store failure, after 10 s', async () => {
      vi.useFakeTimers();
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$s', 1, 'hi @me'))] },
      });
      const { inbox } = setup({ client, index: { page: () => NEVER } });

      const done = firstValueFrom(inbox.refresh());
      await flush();
      // The server's rows don't wait for the store.
      expect(ids(inbox.mentions())).toEqual(['$s']);
      expect(inbox.status()).toBe('loading');

      await vi.advanceTimersByTimeAsync(9_999);
      expect(inbox.status()).toBe('loading');

      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(inbox.status()).toBe('ready');
      expect(inbox.hasMore()).toBe(false);
    });

    it('keeps a row whose check throws, preview unavailable', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$s', 1))] },
      });
      client.getPushActionsForEvent.mockImplementation(() => {
        throw new Error('rules');
      });
      const { inbox, open } = setup({ client });

      await open();

      expect(inbox.all()[0]?.preview).toEqual({ kind: 'unavailable' });
    });
  });

  describe('lifetimes', () => {
    it('drops a late answer after an account switch', async () => {
      const client = fakeClient();
      let answer: (body: unknown) => void = () => undefined;
      client.http.authedRequest.mockImplementation(
        () => new Promise((resolve) => (answer = resolve)) as never,
      );
      const { inbox, switchTo } = setup({ client });
      inbox.refresh().subscribe();
      await flush();

      switchTo(fakeClient(undefined, '@other:hs'));
      answer({ notifications: [entry(message('$a', 1, 'hi @me'))] });
      await flush();

      expect(inbox.mentions()).toEqual([]);
      expect(inbox.all()).toEqual([]);
      expect(inbox.status()).toBe('idle');
    });

    it('reports no late failure after an account switch', async () => {
      const client = fakeClient();
      let refuse: (error: unknown) => void = () => undefined;
      client.http.authedRequest.mockImplementation(
        () => new Promise((_, reject) => (refuse = reject)) as never,
      );
      const { inbox, switchTo } = setup({ client });
      inbox.refresh().subscribe();
      await flush();

      switchTo(fakeClient(undefined, '@other:hs'));
      refuse(new Error('500'));
      await flush();

      expect(inbox.serverListFailed()).toBe(false);
    });

    it('drops a late index answer after an account switch', async () => {
      const client = fakeClient();
      const answers: ((raw: Raw) => void)[] = [];
      client.fetchRoomEvent.mockImplementation(
        () => new Promise((resolve) => answers.push(resolve)),
      );
      const { inbox, store, switchTo } = setup({ client });
      await store.put(ME, { eventId: '$a', roomId: ROOM, ts: 2 }, 2);
      await store.put(ME, { eventId: '$b', roomId: ROOM, ts: 1 }, 2);
      vi.spyOn(Date, 'now').mockReturnValue(100);
      inbox.refresh().subscribe();
      await flush();

      answers[0]?.(message('$a', 2));
      await flush();
      switchTo(fakeClient(undefined, '@other:hs'));
      answers[1]?.(message('$b', 1));
      await flush();

      expect(inbox.mentions()).toEqual([]);
      expect(inbox.hasMore()).toBe(false);
    });

    it('stops Load more after an account switch, and reports nothing', async () => {
      const client = fakeClient(longList());
      const { inbox, switchTo, open } = setup({ client });
      await open();
      client.http.authedRequest.mockClear();
      let answer: (body: unknown) => void = () => undefined;
      client.http.authedRequest.mockImplementationOnce(
        () => new Promise((resolve) => (answer = resolve)) as never,
      );
      inbox.loadMore('mentions').subscribe();
      await flush();

      switchTo(fakeClient(undefined, '@other:hs'));
      answer({ notifications: [entry(message('$p', 1))], next_token: 't9' });
      await flush();

      expect(client.http.authedRequest).toHaveBeenCalledOnce();
      expect(inbox.lastLoad()).toBeNull();
      expect(inbox.hasMore()).toBe(false);
    });

    it('stops Load more when a Refresh replaces it', async () => {
      const client = fakeClient(longList());
      const { inbox, open } = setup({ client });
      await open();
      client.http.authedRequest.mockClear();
      let answer: (body: unknown) => void = () => undefined;
      client.http.authedRequest.mockImplementationOnce(
        () => new Promise((resolve) => (answer = resolve)) as never,
      );
      inbox.loadMore('mentions').subscribe();
      await flush();

      await open();
      answer({ notifications: [entry(message('$p', 1))], next_token: 't9' });
      await flush();

      expect(requests(client)).toEqual([
        { limit: '50', from: 't1' },
        { limit: '50' },
      ]);
      expect(inbox.all()).toHaveLength(50);
    });

    it('stops decrypting a late page after an account switch', async () => {
      const client = fakeClient({
        [FIRST]: {
          rows: Array.from({ length: 10 }, (_, i) =>
            entry(encrypted(`$e${i}`, i)),
          ),
        },
      });
      const release: (() => void)[] = [];
      client.decryptEventIfNeeded.mockImplementation(
        () => new Promise<void>((resolve) => release.push(resolve)),
      );
      const { inbox, switchTo } = setup({ client });
      inbox.refresh().subscribe();
      await flush();
      expect(release).toHaveLength(4);

      switchTo(fakeClient(undefined, '@other:hs'));
      release.forEach((next) => next());
      await flush();

      expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(4);
    });

    it('forgets nothing from a late answer after an account switch', async () => {
      const client = fakeClient();
      let refuse: (error: unknown) => void = () => undefined;
      client.fetchRoomEvent.mockImplementation(
        () => new Promise((_, reject) => (refuse = reject)),
      );
      const { inbox, store, switchTo, remove } = setup({ client });
      await store.put(ME, { eventId: '$i', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);
      inbox.refresh().subscribe();
      await flush();

      switchTo(fakeClient(undefined, '@other:hs'));
      refuse(Object.assign(new Error('x'), { httpStatus: 404 }));
      await flush();

      expect(remove).not.toHaveBeenCalled();
    });

    it('clears on disconnect and on account change', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(encrypted('$e', 1))], next: 't1' },
      });
      client.decryptEventIfNeeded.mockRejectedValue(new Error('no key'));
      const { inbox, switchTo, open } = setup({ client });
      await open();
      expect(inbox.all()).toHaveLength(1);

      inbox.disconnect();
      expect(inbox.all()).toEqual([]);
      expect(inbox.uncheckedCount()).toBe(0);
      expect(inbox.hasMore()).toBe(false);
      expect(inbox.status()).toBe('idle');

      inbox.connect();
      await open();
      expect(inbox.all()).toHaveLength(1);

      switchTo(fakeClient(undefined, '@other:hs'));
      expect(inbox.all()).toEqual([]);
      expect(inbox.status()).toBe('idle');
    });

    it('reads the new account after a switch, under its own account ID', async () => {
      const { inbox, switchTo, open } = setup();
      await open();

      const other = fakeClient(
        { [FIRST]: { rows: [entry(message('$b', 1))] } },
        '@other:hs',
      );
      switchTo(other);
      await open();

      expect(inbox.all()[0]?.accountId).toBe('@other:hs');
    });

    it('does nothing when not connected', async () => {
      const { inbox, client, open } = setup();
      inbox.disconnect();

      await open();
      await firstValueFrom(inbox.loadMore('mentions'));

      expect(client.http.authedRequest).not.toHaveBeenCalled();
      expect(inbox.status()).toBe('idle');
    });

    it('does nothing for a client with no user ID', async () => {
      const client = Object.assign(fakeClient(), { getUserId: () => null });
      const { inbox, open } = setup({ client: client as never });

      await open();

      expect(client.http.authedRequest).not.toHaveBeenCalled();
      expect(inbox.status()).toBe('idle');
    });

    it('a mention arriving while open changes nothing until Refresh', async () => {
      const client = fakeClient();
      const on = vi.fn();
      Object.assign(client, { on, off: vi.fn() });
      const { inbox, store, open } = setup({ client });
      await open();
      expect(on).not.toHaveBeenCalled();

      await store.put(ME, { eventId: '$new', roomId: ROOM, ts: 5 }, 5);
      vi.spyOn(Date, 'now').mockReturnValue(100);
      client.events.set('$new', message('$new', 5, 'hi @me'));
      client.pages[FIRST] = { rows: [entry(message('$new', 5, 'hi @me'))] };
      expect(inbox.mentions()).toEqual([]);

      await open();
      expect(ids(inbox.mentions())).toEqual(['$new']);
    });

    it('replaces index rows on Refresh', async () => {
      const client = fakeClient();
      client.events.set('$i', message('$i', 1));
      const { inbox, store, open } = setup({ client });
      await store.put(ME, { eventId: '$i', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);
      await open();
      expect(inbox.mentions()).toHaveLength(1);

      await store.remove(ME, ['$i']);
      await open();

      expect(inbox.mentions()).toEqual([]);
    });

    it('drops index rows on Refresh once the record is off', async () => {
      const client = fakeClient();
      client.events.set('$i', message('$i', 1));
      const { inbox, store, recordAllowed, open } = setup({ client });
      await store.put(ME, { eventId: '$i', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);
      await open();
      expect(inbox.mentions()).toHaveLength(1);

      recordAllowed.set(false);
      await open();

      expect(inbox.mentions()).toEqual([]);
    });

    it('keeps the old rows until the first answer lands on Refresh', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$a', 1))] },
      });
      const { inbox, open } = setup({ client });
      await open();

      let answer: (body: unknown) => void = () => undefined;
      client.http.authedRequest.mockImplementationOnce(
        () => new Promise((resolve) => (answer = resolve)) as never,
      );
      const done = firstValueFrom(inbox.refresh());
      await flush();
      expect(ids(inbox.all())).toEqual(['$a']);
      expect(inbox.status()).toBe('loading');

      answer({ notifications: [entry(message('$b', 2))] });
      await done;
      expect(ids(inbox.all())).toEqual(['$b']);
    });

    it('keeps the old rows when a Refresh fails', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$a', 1))] },
      });
      const { inbox, open } = setup({ client });
      await open();

      client.http.authedRequest.mockRejectedValueOnce(new Error('500'));
      await open();

      expect(ids(inbox.all())).toEqual(['$a']);
      expect(inbox.serverListFailed()).toBe(true);
      expect(inbox.status()).toBe('ready');
    });

    it('lets a newer Refresh win over an older one', async () => {
      const client = fakeClient();
      const answers: ((body: unknown) => void)[] = [];
      client.http.authedRequest.mockImplementation(
        () => new Promise((resolve) => answers.push(resolve)) as never,
      );
      const { inbox } = setup({ client });
      inbox.refresh().subscribe();
      await flush();
      inbox.refresh().subscribe();
      await flush();

      answers[0]?.({ notifications: [entry(message('$old', 1))] });
      await flush();
      expect(inbox.all()).toEqual([]);
      expect(inbox.status()).toBe('loading');

      answers[1]?.({ notifications: [entry(message('$new', 2))] });
      await flush();

      expect(ids(inbox.all())).toEqual(['$new']);
    });
  });

  describe('rows', () => {
    it('keeps events out of timelines', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$s', 1))] },
      });
      const addLiveEvents = vi.fn();
      client.room = fakeRoom({ addLiveEvents });
      const { open } = setup({ client });

      await open();

      expect(client.getEventMapper).toHaveBeenCalledWith({
        preventReEmit: true,
        decrypt: false,
      });
      expect(client.paginateEventTimeline).not.toHaveBeenCalled();
      expect(client.getNotifTimelineSet).not.toHaveBeenCalled();
      expect(addLiveEvents).not.toHaveBeenCalled();
    });

    it('reads the unread dot from read for server rows, hasUserReadEvent for index rows', async () => {
      const client = fakeClient({
        [FIRST]: {
          rows: [
            entry(message('$unread', 4), false),
            entry(message('$read', 3), true),
            // Held by the index too, where the room says otherwise: the server's flag wins.
            entry(message('$both', 2), true),
          ],
        },
      });
      const hasUserReadEvent = vi.fn(
        (_me: string, id: string) => id === '$seen',
      );
      client.room = fakeRoom({ hasUserReadEvent });
      const now = 1000;
      for (const eventId of ['$seen', '$unseen', '$both']) {
        client.events.set(eventId, message(eventId, 1));
      }
      const { inbox, store, open } = setup({ client });
      for (const eventId of ['$seen', '$unseen', '$both']) {
        await store.put(ME, { eventId, roomId: ROOM, ts: 1 }, now);
      }
      vi.spyOn(Date, 'now').mockReturnValue(now);

      await open();

      const unread = (rows: readonly InboxRow[], id: string) =>
        rows.find((row) => row.eventId === id)?.unread;
      expect(unread(inbox.all(), '$unread')).toBe(true);
      expect(unread(inbox.all(), '$read')).toBe(false);
      expect(unread(inbox.mentions(), '$seen')).toBe(false);
      expect(unread(inbox.mentions(), '$unseen')).toBe(true);
      expect(unread(inbox.mentions(), '$both')).toBe(false);
      expect(hasUserReadEvent).toHaveBeenCalledWith(ME, '$unseen');
    });

    it('names the sender from the room member, else the user ID', async () => {
      const client = fakeClient({
        [FIRST]: {
          rows: [
            entry(message('$a', 2)),
            entry(message('$b', 1, 'x', { sender: '@stranger:hs' })),
          ],
        },
      });
      const { inbox, open } = setup({ client });

      await open();

      expect(inbox.all().map((row) => row.senderName)).toEqual([
        'Alice',
        '@stranger:hs',
      ]);
      expect(inbox.all()[0]?.roomName).toBe('Team');
    });

    it('hides preview text under Always hide and keeps none of it', async () => {
      const secret = 'the secret @me';
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$a', 1, secret))] },
      });
      const { inbox, open } = setup({ client, mode: () => 'always-hide' });

      await open();

      expect(inbox.all()[0]?.preview).toEqual({ kind: 'hidden' });
      expect(inbox.all()[0]?.senderName).toBe('Alice');
      expect(ids(inbox.mentions())).toEqual(['$a']);
      expect(JSON.stringify(inbox.all())).not.toContain('secret');
      expect(JSON.stringify(inbox.mentions())).not.toContain('secret');
    });

    it('shows preview text under hide-on-lock-screen', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$a', 1, 'text'))] },
      });
      const { inbox, open } = setup({
        client,
        mode: () => 'hide-on-lock-screen',
      });

      await open();

      expect(inbox.all()[0]?.preview).toEqual({ kind: 'text', text: 'text' });
    });

    it('does not preview clear text in an encrypted room', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$a', 1, 'planted'))] },
      });
      client.room = fakeRoom({ hasEncryptionStateEvent: () => true });
      const { inbox, open } = setup({ client });

      await open();

      expect(inbox.all()[0]?.preview).toEqual({ kind: 'hidden' });
    });

    it('asks the crypto store before previewing, for every row of a room', async () => {
      const client = fakeClient({
        [FIRST]: {
          rows: [
            entry(message('$a', 2, 'planted')),
            entry(message('$b', 1, 'planted')),
          ],
        },
      });
      client.crypto?.isEncryptionEnabledInRoom.mockResolvedValue(true);
      const { inbox, open } = setup({ client });

      await open();

      expect(inbox.all().map((row) => row.preview.kind)).toEqual([
        'hidden',
        'hidden',
      ]);
    });

    it('waits for a slow crypto store before previewing', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$a', 1, 'planted'))] },
      });
      client.crypto?.isEncryptionEnabledInRoom.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(false))),
      );
      const { inbox, open } = setup({ client });

      await open();

      expect(inbox.all()[0]?.preview).toEqual({
        kind: 'text',
        text: 'planted',
      });
    });

    it('does not preview clear text when the crypto store cannot answer', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$a', 1, 'planted'))] },
      });
      client.crypto?.isEncryptionEnabledInRoom.mockRejectedValue(
        new Error('locked'),
      );
      const { inbox, open } = setup({ client });

      await open();

      expect(inbox.all()[0]?.preview).toEqual({ kind: 'hidden' });
    });

    it('previews the text an edit gave an original, and counts it', async () => {
      const edit = {
        event_id: '$edit',
        room_id: ROOM,
        sender: ALICE,
        type: 'm.room.message',
        origin_server_ts: 2,
        content: {
          body: '* hi @me',
          'm.new_content': { body: 'hi @me' },
          'm.relates_to': { rel_type: 'm.replace', event_id: '$a' },
        },
      };
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$a', 1, 'first'))] },
      });
      client.getEventMapper.mockReturnValue((raw: object) => {
        const event = new MatrixEvent(raw as never);
        event.makeReplaced(new MatrixEvent(edit as never));
        return event;
      });
      const { inbox, open } = setup({ client });

      await open();

      expect(inbox.mentions()[0]?.preview).toEqual({
        kind: 'text',
        text: 'hi @me',
      });
    });

    it('does not show an ignored sender, without forgetting the row', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$s', 2, 'hi @me'))] },
      });
      client.ignored.add(ALICE);
      client.events.set('$i', message('$i', 1, 'hi @me'));
      const { inbox, store, remove, open } = setup({ client });
      await store.put(ME, { eventId: '$i', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();
      await flush();

      expect(inbox.all()).toEqual([]);
      expect(inbox.mentions()).toEqual([]);
      expect(remove).not.toHaveBeenCalled();
      expect(store.rows(ME)).toHaveLength(1);
    });

    it('takes threadRootId only for a reply, not the root', async () => {
      const relates = (eventId: string): Raw => ({
        content: {
          body: 'x',
          'm.relates_to': { rel_type: 'm.thread', event_id: eventId },
        },
      });
      const client = fakeClient({
        [FIRST]: {
          rows: [
            entry(message('$reply', 4, 'x', relates('$root'))),
            entry(message('$root', 3)),
            entry(message('$self', 2, 'x', relates('$self'))),
            // A sender writes this field, and it mustn't carry a selector into a thread lookup.
            entry(message('$bad', 1, 'x', relates('$x"] y'))),
          ],
        },
      });
      const { inbox, open } = setup({ client });

      await open();

      expect(inbox.all().map((row) => row.threadRootId)).toEqual([
        '$root',
        null,
        null,
        null,
      ]);
    });

    it('leaves out an index row whose ID could not be used safely', async () => {
      const client = fakeClient();
      const { inbox, store, remove, open } = setup({ client });
      await store.put(ME, { eventId: '$x"]', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();
      await flush();

      expect(inbox.mentions()).toEqual([]);
      expect(client.fetchRoomEvent).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it('reads an index row from the room when it holds the event', async () => {
      const known = new MatrixEvent(message('$i', 1, 'hi @me') as never);
      const client = fakeClient();
      client.room = fakeRoom({ findEventById: () => known });
      const { inbox, store, open } = setup({ client });
      await store.put(ME, { eventId: '$i', roomId: ROOM, ts: 1 }, 1);
      vi.spyOn(Date, 'now').mockReturnValue(100);

      await open();

      expect(client.fetchRoomEvent).not.toHaveBeenCalled();
      expect(client.getPushActionsForEvent).toHaveBeenCalledWith(known, false);
      expect(inbox.mentions()[0]?.preview).toEqual({
        kind: 'text',
        text: 'hi @me',
      });
    });

    it('caps preview text at PREVIEW_LIMIT', async () => {
      const client = fakeClient({
        [FIRST]: { rows: [entry(message('$a', 1, 'x'.repeat(500)))] },
      });
      const { inbox, open } = setup({ client });

      await open();

      expect(inbox.all()[0]?.preview).toEqual({
        kind: 'text',
        text: 'x'.repeat(140),
      });
    });
  });
});
