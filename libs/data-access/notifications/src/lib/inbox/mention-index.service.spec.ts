import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
  type PreferenceStorageReadOutcome,
} from '@trinity/runtime/preferences';
import {
  MatrixEvent,
  MatrixEventEvent,
  RoomEvent,
  SyncState,
  type IEvent,
} from 'matrix-js-sdk';
import {
  Observable,
  Subject,
  Subscription,
  firstValueFrom,
  of,
  throwError,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KEEP_MENTION_RECORD_PREFERENCE,
  MentionInboxPreferences,
  SHOW_INBOX_PREFERENCE,
  provideMentionInboxPreferences,
} from './mention-inbox.preferences';
import { FakeMentionStore } from './mention-index.spec-harness';
import { MENTION_INDEX_STORE } from './mention-index-store';
import { MentionIndexService } from './mention-index.service';

const ME = '@me:hs';
const TS = Date.UTC(2026, 9, 31);
const SHOW = SHOW_INBOX_PREFERENCE.persistence.key;
const KEEP = KEEP_MENTION_RECORD_PREFERENCE.persistence.key;
const STOPPED = 'mention index: recording stopped for this session';

type Handler = (...args: unknown[]) => void;

/** A client shaped like the bits the recorder reads, with a real listener set. */
function fakeClient(userId: string) {
  const listeners = new Map<string, Set<Handler>>();
  const emit = (type: string, ...args: unknown[]): void => {
    for (const handler of listeners.get(type) ?? []) handler(...args);
  };
  return {
    getUserId: () => userId,
    getPushActionsForEvent: vi.fn(
      (_event: MatrixEvent, _force?: boolean): unknown => ({
        notify: true,
        tweaks: { highlight: true },
      }),
    ),
    getSyncState: () => SyncState.Prepared,
    getSyncStateData: () => ({ fromCache: true }),
    on: vi.fn((type: string, handler: Handler) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(handler));
    }),
    off: vi.fn((type: string, handler: Handler) => {
      listeners.get(type)?.delete(handler);
    }),
    bound: (type: string) => listeners.get(type)?.size ?? 0,
    live: (event: MatrixEvent) =>
      emit(RoomEvent.Timeline, event, undefined, false, false, {
        liveEvent: true,
      }),
    scrollback: (event: MatrixEvent) =>
      emit(RoomEvent.Timeline, event, undefined, true, false, {
        liveEvent: false,
      }),
    decrypted: (event: MatrixEvent) => emit(MatrixEventEvent.Decrypted, event),
  };
}

type FakeClient = ReturnType<typeof fakeClient>;

function message(id: string, overrides: Partial<IEvent> = {}): MatrixEvent {
  return new MatrixEvent({
    event_id: id,
    room_id: '!r:hs',
    sender: '@alice:hs',
    type: 'm.room.message',
    origin_server_ts: TS,
    content: { body: 'hi @me' },
    ...overrides,
  });
}

function encrypted(id: string): MatrixEvent {
  return message(id, { type: 'm.room.encrypted', content: {} });
}

async function decrypt(event: MatrixEvent, ok = true): Promise<void> {
  await event.attemptDecryption(
    {
      decryptEvent: () =>
        ok
          ? Promise.resolve({
              clearEvent: { type: 'm.room.message', content: { body: 'hi' } },
            })
          : Promise.reject(new Error('no key')),
    } as never,
    { isRetry: true },
  );
}

let subscriptions = new Subscription();

/** Drains the store's promises and the reconcile effect. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

function setup(
  opts: {
    stored?: Record<string, unknown>;
    unreadable?: readonly string[];
    accounts?: readonly string[];
    /** The account registry's answer; defaults to the signed-in accounts. */
    registry?: Observable<{ userId: string }[]>;
    /** Holds every preference read until it emits. */
    readsHeld?: Subject<void>;
  } = {},
) {
  const accounts = opts.accounts ?? [ME];
  const stored = opts.stored ?? {};
  const unreadable = opts.unreadable ?? [];
  const adapter: PreferenceStorageAdapter = {
    read: ({ key }) =>
      new Observable<PreferenceStorageReadOutcome>((subscriber) => {
        const answer = (): void => {
          subscriber.next(
            unreadable.includes(key)
              ? { kind: 'unavailable', diagnostic: { code: 'storage-down' } }
              : key in stored
                ? {
                    kind: 'found',
                    payload: JSON.stringify({
                      version: 1,
                      value: stored[key],
                    }),
                  }
                : { kind: 'missing' },
          );
          subscriber.complete();
        };
        if (opts.readsHeld) {
          return opts.readsHeld.subscribe(answer);
        }
        answer();
        return undefined;
      }),
    write: () => of({ kind: 'completed' as const }),
  };
  const clients = new Map<string, FakeClient>(
    accounts.map((id) => [id, fakeClient(id)]),
  );
  const accountIds = signal<readonly string[]>(accounts);
  const store = new FakeMentionStore();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideMentionInboxPreferences(),
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: adapter },
      { provide: MENTION_INDEX_STORE, useValue: store },
      {
        provide: MatrixClientService,
        useValue: {
          accountIds: accountIds.asReadonly(),
          clientFor: (id: string) => clients.get(id) ?? null,
        },
      },
      {
        provide: SessionStorageService,
        useValue: {
          list: () =>
            opts.registry ?? of(accounts.map((userId) => ({ userId }))),
        },
      },
    ],
  });
  const service = TestBed.inject(MentionIndexService);
  const run = async (): Promise<Subscription> => {
    const subscription = service.run().subscribe();
    subscriptions.add(subscription);
    await flush();
    return subscription;
  };
  return {
    service,
    store,
    clients,
    accountIds,
    run,
    client: clients.get(accounts[0] ?? ME) as FakeClient,
    prefs: TestBed.inject(MentionInboxPreferences),
  };
}

afterEach(() => {
  subscriptions.unsubscribe();
  subscriptions = new Subscription();
  vi.restoreAllMocks();
});

describe('MentionIndexService', () => {
  it('records a highlighted live event as eventId, roomId and ts only', async () => {
    const { client, store, run, service } = setup();
    await run();
    expect(service.recording()).toBe(true);

    client.live(message('$a'));
    await flush();

    expect(store.rows(ME)).toEqual([
      { eventId: '$a', roomId: '!r:hs', ts: TS },
    ]);
    expect(Object.keys(store.rows(ME)[0] ?? {}).sort()).toEqual([
      'eventId',
      'roomId',
      'ts',
    ]);
  });

  it('records during catch-up, an old event and a cached sync alike', async () => {
    const { client, store, run } = setup();
    await run();

    client.live(message('$old', { unsigned: { age: 3 * 60 * 60 * 1000 } }));
    await flush();

    expect(store.rows(ME).map((row) => row.eventId)).toEqual(['$old']);
  });

  it('waits for Decrypted, then re-checks with force', async () => {
    const { client, store, run } = setup();
    await run();
    const event = encrypted('$e');

    client.live(event);
    await flush();
    expect(client.getPushActionsForEvent).not.toHaveBeenCalled();
    expect(store.rows(ME)).toEqual([]);

    await decrypt(event);
    client.decrypted(event);
    await flush();
    expect(client.getPushActionsForEvent).toHaveBeenCalledWith(event, true);
    expect(store.rows(ME).map((row) => row.eventId)).toEqual(['$e']);
  });

  it('ignores scrollback that decrypts later', async () => {
    const { client, store, run } = setup();
    await run();
    const event = encrypted('$old');

    client.scrollback(event);
    await decrypt(event);
    client.decrypted(event);
    await flush();

    expect(store.rows(ME)).toEqual([]);
  });

  it('keeps a failed decryption pending for a later retry', async () => {
    const { client, store, run } = setup();
    await run();
    const event = encrypted('$e');

    client.live(event);
    await decrypt(event, false);
    client.decrypted(event);
    await flush();
    expect(client.getPushActionsForEvent).not.toHaveBeenCalled();

    await decrypt(event);
    client.decrypted(event);
    await flush();
    expect(store.rows(ME).map((row) => row.eventId)).toEqual(['$e']);
  });

  it('holds an event whose decryption failed before its timeline emit', async () => {
    const { client, store, run } = setup();
    await run();
    const event = encrypted('$e');
    await decrypt(event, false);

    client.live(event);
    await flush();
    expect(client.getPushActionsForEvent).not.toHaveBeenCalled();

    await decrypt(event);
    client.decrypted(event);
    await flush();
    expect(store.rows(ME).map((row) => row.eventId)).toEqual(['$e']);
  });

  it('caps pending decryptions at 500', async () => {
    const { client, store, run } = setup();
    await run();
    const events = Array.from({ length: 501 }, (_, i) =>
      encrypted(`$e${String(i)}`),
    );
    for (const event of events) client.live(event);

    for (const event of [events[0], events[1]] as MatrixEvent[]) {
      await decrypt(event);
      client.decrypted(event);
    }
    await flush();

    expect(store.rows(ME).map((row) => row.eventId)).toEqual(['$e1']);
  });

  it("skips the person's own messages", async () => {
    const { client, store, run } = setup();
    await run();

    client.live(message('$mine', { sender: ME }));
    await flush();

    expect(store.rows(ME)).toEqual([]);
  });

  it('skips an event the rules do not highlight, as in a muted room', async () => {
    const { client, store, run } = setup();
    await run();

    client.getPushActionsForEvent.mockReturnValue({
      notify: false,
      tweaks: {},
    });
    client.live(message('$muted'));
    client.getPushActionsForEvent.mockReturnValue({
      notify: true,
      tweaks: {},
    });
    client.live(message('$ordinary'));
    client.getPushActionsForEvent.mockReturnValue(null);
    client.live(message('$no-actions'));
    await flush();

    expect(store.rows(ME)).toEqual([]);
  });

  it('skips a redacted event', async () => {
    const { client, store, run } = setup();
    await run();

    client.live(
      message('$gone', {
        unsigned: { redacted_because: {} as never },
      }),
    );
    await flush();

    expect(store.rows(ME)).toEqual([]);
  });

  it('keeps listeners per account and swaps a replaced client', async () => {
    const { clients, accountIds, store, run } = setup({
      accounts: [ME, '@two:hs'],
    });
    await run();
    const first = clients.get(ME) as FakeClient;
    const second = clients.get('@two:hs') as FakeClient;

    first.live(message('$a'));
    second.live(message('$b'));
    await flush();
    expect(store.rows(ME).map((row) => row.eventId)).toEqual(['$a']);
    expect(store.rows('@two:hs').map((row) => row.eventId)).toEqual(['$b']);

    TestBed.tick();
    expect(first.bound(RoomEvent.Timeline)).toBe(1);

    const replaced = fakeClient(ME);
    clients.set(ME, replaced);
    accountIds.set([ME, '@two:hs']);
    TestBed.tick();
    expect(first.bound(RoomEvent.Timeline)).toBe(0);
    expect(first.bound(MatrixEventEvent.Decrypted)).toBe(0);
    expect(replaced.bound(RoomEvent.Timeline)).toBe(1);
    expect(second.bound(RoomEvent.Timeline)).toBe(1);

    clients.delete('@two:hs');
    accountIds.set([ME]);
    TestBed.tick();
    expect(second.bound(RoomEvent.Timeline)).toBe(0);
    expect(replaced.bound(RoomEvent.Timeline)).toBe(1);
  });

  it('never lets a throw reach the SDK emit', async () => {
    const { client, run } = setup();
    await run();
    client.getPushActionsForEvent.mockImplementation(() => {
      throw new Error('rules broke');
    });
    const event = encrypted('$e');
    client.live(event);
    await decrypt(event);

    expect(() => client.live(message('$a'))).not.toThrow();
    expect(() => client.decrypted(event)).not.toThrow();
  });

  it('stops recording for the session when a write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client, store, run, service } = setup();
    await run();
    const put = vi.spyOn(store, 'put');

    store.failNextPut(new DOMException('', 'QuotaExceededError'));
    client.live(message('$a'));
    client.live(message('$b'));
    await flush();

    expect(service.recording()).toBe(false);
    expect(client.off).toHaveBeenCalledWith(
      RoomEvent.Timeline,
      expect.any(Function),
    );
    expect(put).toHaveBeenCalledTimes(1);
    // The one argument is the fixed text, so it holds no event, room or user ID.
    expect(warn).toHaveBeenCalledExactlyOnceWith(STOPPED);
    expect(store.rows(ME)).toEqual([]);
  });

  it('skips a malformed event and keeps recording', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client, store, run, service } = setup();
    await run();

    client.live(message('$no-ts', { origin_server_ts: undefined }));
    client.live(message('$text-ts', { origin_server_ts: 'soon' as never }));
    client.live(message('$no-room', { room_id: undefined }));
    client.live(message('', { event_id: undefined }));
    client.live(message('$good'));
    await flush();

    expect(service.recording()).toBe(true);
    expect(client.bound(RoomEvent.Timeline)).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    expect(store.rows(ME).map((row) => row.eventId)).toEqual(['$good']);
  });

  it('two recorders writing one event leave one row', async () => {
    const { client, store } = setup();
    const [one, two] = TestBed.runInInjectionContext(() => [
      new MentionIndexService(),
      new MentionIndexService(),
    ]) as [MentionIndexService, MentionIndexService];
    subscriptions.add(one.run().subscribe());
    subscriptions.add(two.run().subscribe());
    await flush();
    const put = vi.spyOn(store, 'put');

    client.live(message('$a'));
    await flush();

    expect(put).toHaveBeenCalledTimes(2);
    expect(store.rows(ME)).toHaveLength(1);
  });

  it('records nothing while recording is not allowed', async () => {
    const { client, run, service } = setup({ stored: { [KEEP]: false } });
    await run();

    expect(service.recording()).toBe(false);
    expect(client.on).not.toHaveBeenCalled();
  });

  it('writes nothing once a switch goes off, before the listeners detach', async () => {
    const { client, store, run, prefs } = setup();
    await run();
    const put = vi.spyOn(store, 'put');

    client.live(message('$queued'));
    await firstValueFrom(prefs.setKeepRecord(false));
    client.live(message('$late'));
    await flush();

    expect(put).not.toHaveBeenCalled();
    expect(client.bound(RoomEvent.Timeline)).toBe(0);
  });

  it('starts recording when a switch turns back on', async () => {
    const { client, store, run, prefs } = setup({ stored: { [KEEP]: false } });
    await run();

    await firstValueFrom(prefs.setKeepRecord(true));
    TestBed.tick();
    client.live(message('$a'));
    await flush();

    expect(store.rows(ME).map((row) => row.eventId)).toEqual(['$a']);
  });

  it('at start with a switch read as off, deletes everything', async () => {
    for (const stored of [{ [SHOW]: false }, { [KEEP]: false }]) {
      const { store, run, service } = setup({ stored });
      const sweep = vi.spyOn(store, 'keepOnlyAccounts');
      const deleteAll = vi
        .spyOn(store, 'deleteAll')
        .mockRejectedValueOnce(new Error('blocked'));
      await store.put(ME, { eventId: '$a', roomId: '!r:hs', ts: TS }, TS);

      const first = await run();
      expect(service.deleteFailed()).toBe(true);
      expect(store.rows(ME)).toHaveLength(1);
      first.unsubscribe();

      // The next start is the retry.
      await run();
      expect(deleteAll).toHaveBeenCalledTimes(2);
      expect(service.deleteFailed()).toBe(false);
      expect(store.rows(ME)).toEqual([]);
      expect(sweep).not.toHaveBeenCalled();
    }
  });

  it('at start with an unreadable setting, records nothing and deletes nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const options of [
      { unreadable: [KEEP] },
      { unreadable: [SHOW] },
      { unreadable: [KEEP], stored: { [SHOW]: false } },
      { stored: { [SHOW]: 'yes' } },
    ]) {
      warn.mockClear();
      const { client, store, run, prefs, service } = setup(options);
      const deleteAll = vi.spyOn(store, 'deleteAll');
      const sweep = vi.spyOn(store, 'keepOnlyAccounts');
      await store.put(ME, { eventId: '$a', roomId: '!r:hs', ts: TS }, TS);

      await run();

      expect(service.recording()).toBe(false);
      expect(client.on).not.toHaveBeenCalled();
      expect(deleteAll).not.toHaveBeenCalled();
      expect(sweep).not.toHaveBeenCalled();
      expect(store.rows(ME)).toHaveLength(1);
      expect(warn).toHaveBeenCalledExactlyOnceWith(STOPPED);

      // Recording stays stopped for the session even once both switches read on.
      await firstValueFrom(prefs.setShowInbox(true));
      await firstValueFrom(prefs.setKeepRecord(true));
      await flush();
      expect(prefs.recordAllowed()).toBe(true);
      expect(service.recording()).toBe(false);
      expect(client.on).not.toHaveBeenCalled();
    }
  });

  it('at start with the settings read throwing, records nothing and deletes nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client, store, run, prefs, service } = setup();
    vi.spyOn(prefs, 'init').mockReturnValue(
      throwError(() => new Error('read failed')),
    );
    const deleteAll = vi.spyOn(store, 'deleteAll');

    await run();

    expect(service.recording()).toBe(false);
    expect(client.on).not.toHaveBeenCalled();
    expect(deleteAll).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(STOPPED);
  });

  it('at start with recording allowed, forgets accounts no longer stored', async () => {
    const { store, run } = setup();
    const deleteAll = vi.spyOn(store, 'deleteAll');
    await store.put('@gone:hs', { eventId: '$g', roomId: '!r:hs', ts: TS }, TS);
    await store.put(ME, { eventId: '$a', roomId: '!r:hs', ts: TS }, TS);

    await run();

    expect(store.rows('@gone:hs')).toEqual([]);
    expect(store.rows(ME)).toHaveLength(1);
    expect(deleteAll).not.toHaveBeenCalled();
  });

  it('at start with an empty registry, forgets every account', async () => {
    const { store, run } = setup({ registry: of([]) });
    await store.put('@gone:hs', { eventId: '$g', roomId: '!r:hs', ts: TS }, TS);

    await run();

    expect(store.rows('@gone:hs')).toEqual([]);
  });

  it('at start with an unreadable registry, skips the sweep and records', async () => {
    for (const registry of [
      throwError(() => new Error('registry down')),
      // A registry blob without its list answers, but says nothing about the accounts.
      of(undefined) as unknown as Observable<{ userId: string }[]>,
    ]) {
      const { client, store, run, service } = setup({ registry });
      const sweep = vi.spyOn(store, 'keepOnlyAccounts');
      await store.put(
        '@gone:hs',
        { eventId: '$g', roomId: '!r:hs', ts: TS },
        TS,
      );

      await run();
      expect(sweep).not.toHaveBeenCalled();
      expect(store.rows('@gone:hs')).toHaveLength(1);
      expect(service.recording()).toBe(true);

      client.live(message('$a'));
      await flush();
      expect(store.rows(ME)).toHaveLength(1);
    }
  });

  it('a failed sweep leaves recording on', async () => {
    const { client, store, run, service } = setup();
    vi.spyOn(store, 'keepOnlyAccounts').mockRejectedValueOnce(new Error('no'));

    await run();
    client.live(message('$a'));
    await flush();

    expect(service.recording()).toBe(true);
    expect(store.rows(ME)).toHaveLength(1);
  });

  it('reads the switches before the first write and the start-up work', async () => {
    const readsHeld = new Subject<void>();
    const { client, store, run } = setup({ readsHeld });
    const sweep = vi.spyOn(store, 'keepOnlyAccounts');

    await run();
    expect(client.on).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();

    readsHeld.next();
    await flush();
    readsHeld.next();
    await flush();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(client.bound(RoomEvent.Timeline)).toBe(1);
  });

  it('a stop during start-up starts nothing', async () => {
    const readsHeld = new Subject<void>();
    const { client, store, run, service } = setup({ readsHeld });
    const sweep = vi.spyOn(store, 'keepOnlyAccounts');

    await run();
    await firstValueFrom(service.stop());
    readsHeld.next();
    await flush();
    readsHeld.next();
    await flush();

    expect(sweep).not.toHaveBeenCalled();
    expect(service.recording()).toBe(false);
    expect(client.on).not.toHaveBeenCalled();
  });

  it('stop detaches at once and waits for the write in flight', async () => {
    const { client, store, run, service } = setup();
    await run();
    let release: () => void = () => undefined;
    const put = vi.spyOn(store, 'put').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    client.live(message('$in-flight'));
    client.live(message('$queued'));
    await new Promise((resolve) => setTimeout(resolve));

    const stopped = vi.fn();
    service.stop().subscribe({ complete: stopped });
    expect(client.bound(RoomEvent.Timeline)).toBe(0);
    expect(service.recording()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve));
    expect(stopped).not.toHaveBeenCalled();

    release();
    await new Promise((resolve) => setTimeout(resolve));
    expect(stopped).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
  });

  it('releases the listeners when its run ends', async () => {
    const { client, run, service } = setup();
    const subscription = await run();

    subscription.unsubscribe();

    expect(service.recording()).toBe(false);
    expect(client.bound(RoomEvent.Timeline)).toBe(0);
    expect(client.bound(MatrixEventEvent.Decrypted)).toBe(0);
  });

  it('an earlier run ending leaves the newer one recording', async () => {
    const { client, run, service } = setup();
    const earlier = await run();
    await firstValueFrom(service.stop());
    await run();

    earlier.unsubscribe();

    expect(service.recording()).toBe(true);
    expect(client.bound(RoomEvent.Timeline)).toBe(1);
  });

  it('a write failure lasts for that run, not the next', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client, store, run, service } = setup();
    const first = await run();
    store.failNextPut(new Error('storage'));
    client.live(message('$a'));
    await flush();
    expect(service.recording()).toBe(false);
    first.unsubscribe();

    await run();

    expect(service.recording()).toBe(true);
  });

  it('deleteAll sets deleteFailed on rejection and clears it on success', async () => {
    const { store, service } = setup();
    vi.spyOn(store, 'deleteAll').mockRejectedValueOnce(new Error('blocked'));

    await expect(firstValueFrom(service.deleteAll())).rejects.toThrow(
      'blocked',
    );
    expect(service.deleteFailed()).toBe(true);

    await firstValueFrom(service.deleteAll());
    expect(service.deleteFailed()).toBe(false);
    expect(store.deleted).toBe(true);
  });

  it('runs a delete after the writes queued before it', async () => {
    const { client, store, run, service } = setup();
    await run();

    for (const remove of [
      () => service.deleteAll(),
      () => service.forgetAccount(ME),
      () => service.forget(ME, ['$a']),
    ]) {
      client.live(message('$a'));
      await firstValueFrom(remove());
      expect(store.rows(ME)).toEqual([]);
    }
  });

  it('reads and forgets through the store', async () => {
    const { store, service } = setup();
    const row = (eventId: string, ts: number) => ({
      eventId,
      roomId: '!r:hs',
      ts,
    });
    const now = Date.now();
    await store.put(ME, row('$a', now - 2), now);
    await store.put(ME, row('$b', now - 1), now);
    await store.put('@two:hs', row('$c', now), now);

    expect(await firstValueFrom(service.page(ME, null, 1))).toEqual([
      row('$b', now - 1),
    ]);
    expect(
      await firstValueFrom(
        service.page(ME, { ts: now - 1, eventId: '$b' }, 10),
      ),
    ).toEqual([row('$a', now - 2)]);
    expect(await firstValueFrom(service.count())).toBe(3);
    expect(await firstValueFrom(service.count(ME))).toBe(2);

    await firstValueFrom(service.forget(ME, ['$a']));
    expect(store.rows(ME).map((r) => r.eventId)).toEqual(['$b']);

    await firstValueFrom(service.forgetAccount(ME));
    expect(store.rows(ME)).toEqual([]);
    expect(store.rows('@two:hs')).toHaveLength(1);
  });

  it('is cold: nothing runs until subscribed', () => {
    const { client, store, service } = setup();
    const deleteAll = vi.spyOn(store, 'deleteAll');
    const put = vi.spyOn(store, 'put');

    service.run();
    service.stop();
    service.deleteAll();
    TestBed.tick();

    expect(client.on).not.toHaveBeenCalled();
    expect(deleteAll).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
