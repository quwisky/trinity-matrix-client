import {
  ClientEvent,
  ConnectionError,
  EventStatus,
  MsgType,
  SyncState,
  createClient,
} from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from './matrix-client.service';
import { SESSION, fakeClient, setup } from './matrix-client.spec-harness';

// A controllable fake sync store (the real IndexedDBStore needs a browser IDB).
const storeMock = vi.hoisted(() => ({ startup: vi.fn(), destroy: vi.fn() }));

// Keep the real enums (ClientEvent/SyncState) but stub the client factory + store.
vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>();
  return {
    ...actual,
    createClient: vi.fn(),
    IndexedDBStore: class {
      startup = storeMock.startup;
      destroy = storeMock.destroy;
    },
  };
});

// In-memory @capacitor/preferences, for the tests that run the real SessionStorageService.
const { prefs } = vi.hoisted(() => ({ prefs: new Map<string, string>() }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({
      value: prefs.get(key) ?? null,
    }),
    set: async ({ key, value }: { key: string; value: string }) => {
      prefs.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      prefs.delete(key);
    },
  },
}));

// The WASM preload is a no-op in tests (no real crypto engine).
vi.mock('./crypto-wasm-loader', async () => {
  const { of: rxOf } = await import('rxjs');
  return { preloadCryptoWasm: () => rxOf(undefined) };
});

describe('MatrixClientService session handover', () => {
  beforeEach(() => {
    vi.mocked(createClient).mockReset();
    storeMock.startup.mockReset().mockResolvedValue(undefined);
    storeMock.destroy.mockReset().mockResolvedValue(undefined);
  });

  let nextEcho = 0;

  /** A local echo as the SDK keeps it in a live timeline. */
  function echo(
    status: EventStatus | null,
    content: Record<string, unknown> = { msgtype: 'm.text', body: 'hello' },
    options: {
      readonly id?: string;
      readonly type?: string;
      readonly threadRootId?: string;
      readonly edit?: boolean;
      readonly txnId?: string;
    } = {},
  ) {
    const id = options.id ?? `~!room:hs:txn${++nextEcho}`;
    return {
      status,
      getId: () => id,
      getType: () => options.type ?? 'm.room.message',
      getContent: () => content,
      isRelation: (relType?: string) =>
        options.edit === true && relType === 'm.replace',
      threadRootId: options.threadRootId,
      getTxnId: () => options.txnId,
    };
  }

  type Echo = ReturnType<typeof echo>;

  /** A live client with a sync loop, room `!room:hs` whose timelines hold the echoes, and `uploads`. */
  function handoverClient(
    events: Echo[] = [],
    threadEvents: Echo[] = [],
    uploads: unknown[] = [],
    { inFlightMap = true }: { readonly inFlightMap?: boolean } = {},
  ) {
    const timeline = (list: Echo[]) => ({ getEvents: () => list });
    // As in the SDK with `chronological` ordering: a thread reply's echo is in no timeline, and
    // `txnToEvent` lists every echo in send order.
    const room = {
      roomId: '!room:hs',
      getLiveTimeline: () => timeline(events),
      getThreads: () => [{ liveTimeline: timeline([]) }],
      // Joined and already encrypted, so the encryption repair a sync runs passes it over.
      getMyMembership: () => 'join',
      hasEncryptionStateEvent: () => true,
      get txnToEvent() {
        return new Map(
          [...events, ...threadEvents]
            .filter((event) => event.status !== null)
            .map((event) => [event.getId(), event] as const),
        );
      },
    };
    if (!inFlightMap) delete (room as { txnToEvent?: unknown }).txnToEvent;
    return {
      ...fakeClient(),
      syncApi: { stop: vi.fn() },
      getCurrentUploads: vi.fn(() => uploads),
      getRooms: vi.fn(() => [room]),
    };
  }

  async function liveService(client: ReturnType<typeof handoverClient>) {
    const { svc } = setup(client);
    await firstValueFrom(svc.init(SESSION));
    return svc;
  }

  it('pauses sync on every live client without stopping it', async () => {
    const client = handoverClient();
    const svc = await liveService(client);

    svc.pauseSync();

    expect(client.syncApi.stop).toHaveBeenCalledOnce();
    expect(client.stopClient).not.toHaveBeenCalled();
    expect(svc.clientFor(SESSION.userId)).toBe(client);
  });

  it('does not resend a message that failed offline once sync is paused', async () => {
    const offline = {
      ...echo(EventStatus.NOT_SENT),
      error: new ConnectionError('offline'),
    };
    const client = {
      ...handoverClient([offline]),
      resendEvent: vi.fn().mockResolvedValue(undefined),
    };
    const svc = await liveService(client);
    const onSync = client.on.mock.calls.find(
      ([evt]) => evt === ClientEvent.Sync,
    )![1] as (state: SyncState, previous: SyncState | null) => void;

    svc.pauseSync();
    onSync(SyncState.Reconnecting, SyncState.Syncing);
    onSync(SyncState.Syncing, SyncState.Reconnecting);
    await new Promise((resolve) => setTimeout(resolve));

    expect(client.resendEvent).not.toHaveBeenCalled();
  });

  it.each([EventStatus.QUEUED, EventStatus.ENCRYPTING, EventStatus.SENDING])(
    'counts a message that is %s as outgoing work',
    async (status) => {
      const svc = await liveService(handoverClient([echo(null), echo(status)]));

      expect(svc.hasOutgoingWork()).toBe(true);
    },
  );

  it('counts a thread reply on its way and an upload as outgoing work', async () => {
    const threadEvents: Echo[] = [];
    const uploads: unknown[] = [];
    const svc = await liveService(handoverClient([], threadEvents, uploads));
    expect(svc.hasOutgoingWork()).toBe(false);

    threadEvents.push(
      echo(EventStatus.SENDING, undefined, { threadRootId: '$root' }),
    );
    expect(svc.hasOutgoingWork()).toBe(true);

    threadEvents.length = 0;
    uploads.push({ loaded: 1, total: 2 });
    expect(svc.hasOutgoingWork()).toBe(true);
  });

  it('reports no outgoing work once messages are sent, failed or cancelled', async () => {
    const svc = await liveService(
      handoverClient([
        echo(null),
        echo(EventStatus.SENT),
        echo(EventStatus.NOT_SENT),
        echo(EventStatus.CANCELLED),
      ]),
    );

    expect(svc.hasOutgoingWork()).toBe(false);
  });

  it.each([
    EventStatus.QUEUED,
    EventStatus.ENCRYPTING,
    EventStatus.SENDING,
    EventStatus.NOT_SENT,
  ])('returns a text message that is %s as unsent', async (status) => {
    const svc = await liveService(
      handoverClient([echo(status, { msgtype: 'm.text', body: 'see you' })]),
    );

    expect(svc.pendingTextMessages()).toEqual([
      {
        accountId: '@me:hs',
        roomId: '!room:hs',
        threadRootId: null,
        text: 'see you',
      },
    ]);
  });

  it('names the transaction of an unsent text, so its waiting record can be released', async () => {
    const svc = await liveService(
      handoverClient([
        echo(
          EventStatus.NOT_SENT,
          { msgtype: 'm.text', body: 'see you' },
          { txnId: 'txn-7' },
        ),
      ]),
    );

    expect(svc.pendingTextMessages()).toEqual([
      expect.objectContaining({ text: 'see you', txnId: 'txn-7' }),
    ]);
  });

  it('never returns a message the server already has', async () => {
    const svc = await liveService(
      handoverClient([
        echo(null, { msgtype: 'm.text', body: 'delivered' }),
        echo(EventStatus.SENT, { msgtype: 'm.text', body: 'accepted' }),
        echo(EventStatus.CANCELLED, { msgtype: 'm.text', body: 'withdrawn' }),
      ]),
    );

    expect(svc.pendingTextMessages()).toEqual([]);
  });

  it('keeps the thread of an unsent reply, and makes an emote a /me line again', async () => {
    const svc = await liveService(
      handoverClient(
        [echo(EventStatus.SENDING, { msgtype: 'm.emote', body: 'waves' })],
        [
          echo(
            EventStatus.ENCRYPTING,
            { msgtype: 'm.text', body: 'in the thread' },
            { threadRootId: '$root' },
          ),
        ],
      ),
    );

    expect(svc.pendingTextMessages()).toEqual([
      {
        accountId: '@me:hs',
        roomId: '!room:hs',
        threadRootId: null,
        text: '/me waves',
      },
      {
        accountId: '@me:hs',
        roomId: '!room:hs',
        threadRootId: '$root',
        text: 'in the thread',
      },
    ]);
  });

  it('brings a reply back without the quote of the message it answers', async () => {
    const svc = await liveService(
      handoverClient(
        [
          echo(EventStatus.SENDING, {
            msgtype: 'm.text',
            body: '> <@alice:hs> lunch at noon?\n\nsee you there',
            format: 'org.matrix.custom.html',
            formatted_body: '<mx-reply>…</mx-reply>see you there',
            'm.relates_to': { 'm.in_reply_to': { event_id: '$question' } },
          }),
        ],
        [
          // A thread's fallback reply quotes nothing: a leading `>` is the user's own quote.
          echo(
            EventStatus.SENDING,
            {
              msgtype: 'm.text',
              body: '> as the docs say',
              'm.relates_to': {
                rel_type: 'm.thread',
                event_id: '$root',
                is_falling_back: true,
                'm.in_reply_to': { event_id: '$latest' },
              },
            },
            { threadRootId: '$root' },
          ),
        ],
      ),
    );

    expect(svc.pendingTextMessages().map((message) => message.text)).toEqual([
      'see you there',
      '> as the docs say',
    ]);
  });

  it('keeps a spoiler hidden by bringing it back as a /spoiler command', async () => {
    const svc = await liveService(
      handoverClient([
        echo(EventStatus.NOT_SENT, {
          msgtype: 'm.text',
          body: 'the butler did it',
          format: 'org.matrix.custom.html',
          formatted_body: '<span data-mx-spoiler>the butler did it</span>',
        }),
      ]),
    );

    expect(svc.pendingTextMessages().map((message) => message.text)).toEqual([
      '/spoiler the butler did it',
    ]);
  });

  it('does not take a message that merely mentions a spoiler for one', async () => {
    const svc = await liveService(
      handoverClient([
        echo(EventStatus.NOT_SENT, {
          msgtype: 'm.text',
          body: 'read **this**',
          format: 'org.matrix.custom.html',
          formatted_body:
            'read <b>this</b> <span data-mx-spoiler>not hidden by me</span>',
        }),
      ]),
    );

    expect(svc.pendingTextMessages().map((message) => message.text)).toEqual([
      'read **this**',
    ]);
  });

  it('still finds the main timeline echoes if the SDK drops its in-flight map', async () => {
    const svc = await liveService(
      handoverClient(
        [echo(EventStatus.SENDING, { msgtype: 'm.text', body: 'kept' })],
        [],
        [],
        { inFlightMap: false },
      ),
    );

    expect(svc.hasOutgoingWork()).toBe(true);
    expect(svc.pendingTextMessages().map((message) => message.text)).toEqual([
      'kept',
    ]);
  });

  it('drops uploads, media, edits, blank bodies and other event types, and counts an echo once', async () => {
    const shared = echo(EventStatus.SENDING, {
      msgtype: 'm.text',
      body: 'once',
    });
    const svc = await liveService(
      handoverClient(
        [
          shared,
          echo(EventStatus.SENDING, { msgtype: 'm.image', body: 'pic.png' }),
          echo(EventStatus.NOT_SENT, { msgtype: 'm.file', body: 'a.pdf' }),
          echo(
            EventStatus.SENDING,
            { msgtype: 'm.text', body: '* fixed' },
            { edit: true },
          ),
          echo(EventStatus.SENDING, { msgtype: 'm.text', body: '   ' }),
          echo(EventStatus.SENDING, { key: '👍' }, { type: 'm.reaction' }),
        ],
        [shared],
        [{ loaded: 1, total: 2 }],
      ),
    );

    expect(svc.pendingTextMessages().map((message) => message.text)).toEqual([
      'once',
    ]);
  });
});

describe('MatrixClientService session handover with a real MatrixClient', () => {
  // The client, its rooms, threads and local echoes are matrix-js-sdk 43's own, started with
  // its default `chronological` pending-event ordering. Only the network is fake.
  const ROOM_ID = '!room:hs';
  const ROOT_ID = '$root';

  type SendFate = 'hang' | 'fail';

  // What each test started, so `afterEach` can stop the real clients and undo the global
  // thread-support flag the SDK latches on `Thread`.
  let started: MatrixClientService | null = null;
  let restoreThreadSupport: (() => void) | null = null;

  async function startWithRoom(fate: SendFate) {
    const actual =
      await vi.importActual<typeof import('matrix-js-sdk')>('matrix-js-sdk');
    vi.mocked(createClient).mockReset();
    vi.mocked(createClient).mockImplementation((opts) => {
      const client = actual.createClient(opts);
      vi.spyOn(client, 'initRustCrypto').mockResolvedValue(undefined);
      vi.spyOn(client, 'clearStores').mockResolvedValue(undefined);
      // Threads need server support, which a real startClient() would discover.
      vi.spyOn(client, 'supportsThreads').mockReturnValue(true);
      if (!restoreThreadSupport) {
        const previous = actual.Thread.hasServerSideSupport;
        restoreThreadSupport = () =>
          actual.Thread.setServerSideSupport(previous);
      }
      actual.Thread.setServerSideSupport(actual.FeatureSupport.Stable);
      return client;
    });
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname.endsWith('/whoami')) {
          return new Response(
            JSON.stringify({ user_id: '@me:hs', device_id: 'DEV' }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        if (init.method === 'PUT' && url.pathname.includes('/send/')) {
          if (fate === 'hang') {
            // Pending until the client is stopped and aborts it.
            return new Promise<Response>((_, reject) => {
              init.signal?.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError')),
              );
            });
          }
          return new Response(
            JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'no' }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          );
        }
        throw new TypeError('Failed to fetch');
      }),
    );
    storeMock.startup.mockReset().mockResolvedValue(undefined);
    storeMock.destroy.mockReset().mockResolvedValue(undefined);
    const { svc } = setup();
    started = svc;
    await firstValueFrom(svc.init(SESSION));
    const client = svc.clientFor(SESSION.userId)!;
    const room = new actual.Room(ROOM_ID, client, '@me:hs', {});
    client.store.storeRoom(room);
    const root = new actual.MatrixEvent({
      event_id: ROOT_ID,
      type: 'm.room.message',
      sender: '@alice:hs',
      room_id: ROOM_ID,
      origin_server_ts: 1,
      content: { msgtype: MsgType.Text, body: 'root' },
    });
    room.addLiveEvents([root], { addToState: false });
    room.createThread(ROOT_ID, root, [], false);
    return { svc, client };
  }

  afterEach(async () => {
    if (started) await firstValueFrom(started.stop());
    started = null;
    restoreThreadSupport?.();
    restoreThreadSupport = null;
    vi.unstubAllGlobals();
  });

  it.each<SendFate>(['hang', 'fail'])(
    'finds a thread reply whose send will %s',
    async (fate) => {
      const { svc, client } = await startWithRoom(fate);

      void client
        .sendMessage(ROOM_ID, ROOT_ID, {
          msgtype: MsgType.Text,
          body: 'in thread',
        })
        .catch(() => undefined);
      await vi.waitFor(() => expect(svc.pendingTextMessages()).toHaveLength(1));

      expect(svc.pendingTextMessages()).toEqual([
        {
          accountId: '@me:hs',
          roomId: ROOM_ID,
          threadRootId: ROOT_ID,
          text: 'in thread',
          txnId: expect.any(String),
        },
      ]);
      // A failed send is no longer on its way; a hanging one is.
      await vi.waitFor(() =>
        expect(svc.hasOutgoingWork()).toBe(fate === 'hang'),
      );
    },
  );

  it.each<SendFate>(['hang', 'fail'])(
    'finds a room message whose send will %s, in the order sent',
    async (fate) => {
      const { svc, client } = await startWithRoom(fate);

      for (const body of ['first', 'second']) {
        void client
          .sendMessage(ROOM_ID, null, { msgtype: MsgType.Text, body })
          .catch(() => undefined);
      }
      await vi.waitFor(() => expect(svc.pendingTextMessages()).toHaveLength(2));

      expect(
        svc.pendingTextMessages().map((m) => [m.threadRootId, m.text]),
      ).toEqual([
        [null, 'first'],
        [null, 'second'],
      ]);
      await vi.waitFor(() =>
        expect(svc.hasOutgoingWork()).toBe(fate === 'hang'),
      );
    },
  );

  it('has a sync loop to pause once the client has started', async () => {
    const actual =
      await vi.importActual<typeof import('matrix-js-sdk')>('matrix-js-sdk');
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const client = actual.createClient({
      baseUrl: 'https://hs.example',
      userId: '@me:hs',
      accessToken: 'tok',
    });
    vi.spyOn(client, 'initRustCrypto').mockResolvedValue(undefined);

    await client.startClient({ initialSyncLimit: 1 });
    try {
      // `pauseSync()` relies on this protected member; a rename in the SDK fails here.
      const loop = (client as unknown as { syncApi?: { stop?: unknown } })
        .syncApi;
      expect(typeof loop?.stop).toBe('function');
    } finally {
      client.stopClient();
    }
  });
});
