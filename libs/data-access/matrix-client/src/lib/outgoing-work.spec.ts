import {
  ConnectionError,
  EventStatus,
  MatrixError,
  ClientEvent,
  MatrixEvent,
  SyncState,
  createClient,
  type MatrixClient,
} from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  PAUSED_LOOP_EXIT_TIMEOUT_MS,
  pauseClientSync,
  resendWaitingEchoes,
  resumeClientSync,
} from './outgoing-work';

function waiting(body: string): MatrixEvent {
  const event = new MatrixEvent({
    type: 'm.room.message',
    content: { msgtype: 'm.text', body },
  });
  event.status = EventStatus.NOT_SENT;
  event.error = new ConnectionError('offline') as never;
  return event;
}

/** A room; `inFlight` stands in for the SDK's `txnToEvent`, the only list of a thread echo. */
function room(
  roomId: string,
  events: MatrixEvent[],
  inFlight: MatrixEvent[] = [],
) {
  return {
    roomId,
    txnToEvent: new Map(inFlight.map((event, i) => [`txn${i}`, event])),
    getLiveTimeline: () => ({ getEvents: () => events }),
    getThreads: () => [],
  };
}

function client(
  rooms: ReturnType<typeof room>[],
  resendEvent: (event: MatrixEvent) => Promise<unknown>,
) {
  return {
    getRooms: () => rooms,
    resendEvent: vi.fn(resendEvent),
  };
}

const run = (fake: ReturnType<typeof client>, live = () => true) =>
  resendWaitingEchoes(fake as unknown as MatrixClient, live);

describe('resendWaitingEchoes', () => {
  it('skips a cancelled echo', async () => {
    const echo = waiting('gone');
    const fake = client([room('!r:hs', [echo])], () => Promise.resolve());
    echo.status = EventStatus.CANCELLED;

    await run(fake);

    expect(fake.resendEvent).not.toHaveBeenCalled();
  });

  it("resends a room's echoes in timeline order, one at a time", async () => {
    const first = waiting('one');
    const second = waiting('two');
    let release!: () => void;
    const fake = client([room('!r:hs', [first, second])], (event) =>
      event === first
        ? new Promise<void>((resolve) => (release = resolve))
        : Promise.resolve(),
    );

    const done = run(fake);
    await Promise.resolve();
    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
    ]);

    release();
    await done;
    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
      second,
    ]);
  });

  it('puts resent echoes after what arrived while they waited, still in send order', async () => {
    const first = waiting('one');
    const second = waiting('two');
    first.event.event_id = '~!r:hs:1';
    second.event.event_id = '~!r:hs:2';
    const arrived = new MatrixEvent({
      type: 'm.room.message',
      event_id: '$arrived',
      content: { msgtype: 'm.text', body: 'later' },
    });
    const events = [first, second, arrived];
    const fake = client([room('!r:hs', events)], () => Promise.resolve());
    fake.getRooms()[0].getLiveTimeline = () =>
      ({
        getEvents: () => events,
        removeEvent: (id: string) => {
          const at = events.findIndex((e) => e.getId() === id);
          return at < 0 ? null : events.splice(at, 1)[0];
        },
        addEvent: (e: MatrixEvent) => void events.push(e),
      }) as never;

    await run(fake);

    expect(events.map((e) => e.getId())).toEqual([
      '$arrived',
      '~!r:hs:1',
      '~!r:hs:2',
    ]);
  });

  it('skips an echo whose status changed before its turn', async () => {
    const first = waiting('one');
    const second = waiting('two');
    const fake = client([room('!r:hs', [first, second])], async (event) => {
      // A manual Retry of the second one won the race while the first was sending.
      if (event === first) second.status = EventStatus.SENDING;
    });

    await run(fake);

    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
    ]);
  });

  it('an echo that fails again with ConnectionError stays waiting for the next reconnect', async () => {
    const [first, second, third] = ['one', 'two', 'three'].map(waiting);
    const other = waiting('elsewhere');
    const fake = client(
      [room('!r:hs', [first, second, third]), room('!o:hs', [other])],
      async (event) => {
        if (event === first) throw new ConnectionError('offline again');
      },
    );

    await expect(run(fake)).resolves.toBeUndefined();

    // The rest of the room waits behind it, so its order holds.
    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
      other,
    ]);
    expect(first.status).toBe(EventStatus.NOT_SENT);
  });

  it("ends a room's pass at a rate limit, leaving other rooms going", async () => {
    const [first, second] = ['one', 'two'].map(waiting);
    const other = waiting('elsewhere');
    const fake = client(
      [room('!r:hs', [first, second]), room('!o:hs', [other])],
      async (event) => {
        if (event === first) {
          throw new MatrixError({ errcode: 'M_LIMIT_EXCEEDED' }, 429);
        }
      },
    );

    await expect(run(fake)).resolves.toBeUndefined();

    // The next sync tick picks the room up again, in order.
    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
      other,
    ]);
  });

  it('carries on past an echo the server refuses', async () => {
    const first = waiting('one');
    const second = waiting('two');
    const fake = client([room('!r:hs', [first, second])], async (event) => {
      if (event === first)
        throw new MatrixError({ errcode: 'M_FORBIDDEN' }, 403);
    });

    await run(fake);

    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
      second,
    ]);
  });

  it('stops once the account is no longer live', async () => {
    const first = waiting('one');
    const second = waiting('two');
    let live = true;
    const fake = client([room('!r:hs', [first, second])], async () => {
      live = false;
    });

    await run(fake, () => live);

    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
    ]);
  });

  it('resends a thread echo that only the in-flight map lists, in send order', async () => {
    const main = waiting('main');
    const reply = waiting('in a thread');
    const fake = client(
      [room('!r:hs', [main], [main, reply])],
      async () => undefined,
    );

    await run(fake);

    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      main,
      reply,
    ]);
  });

  it('resends each room independently', async () => {
    const a = waiting('a');
    const b = waiting('b');
    const fake = client(
      [room('!a:hs', [a]), room('!b:hs', [b])],
      () => new Promise<void>(() => undefined),
    );

    void run(fake);
    await Promise.resolve();

    expect(fake.resendEvent).toHaveBeenCalledTimes(2);
  });
});

describe('pausing and resuming a real sync loop', () => {
  /**
   * A client on a fake homeserver: the first `/sync` answers `s1`, every later one waits until
   * it is aborted unless `respond` answers it first. `syncs` lists each `/sync` request's query.
   */
  function fakeServerClient() {
    const syncs: URLSearchParams[] = [];
    const pending: ((body: unknown) => void)[] = [];
    /** `pushRulesFail`: push rules answer 500; `versionsHang`: `/versions` waits until aborted. */
    const server = { pushRulesFail: false, versionsHang: false };
    const hang = (init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      );
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const fetchFn = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/versions'))
        return server.versionsHang ? hang(init) : json({ versions: ['v1.11'] });
      if (url.pathname.includes('/pushrules'))
        return server.pushRulesFail
          ? json({ errcode: 'M_UNKNOWN' }, 500)
          : json({ global: {} });
      // A filter id the SDK remembered from an earlier test reads back as a different filter.
      if (url.pathname.includes('/filter'))
        return json(init?.method === 'POST' ? { filter_id: 'f1' } : {});
      if (url.pathname.endsWith('/sync')) {
        syncs.push(url.searchParams);
        if (syncs.length === 1 && !url.searchParams.has('since'))
          return json({ next_batch: 's1' });
        return new Promise((resolve, reject) => {
          pending.push((body) => resolve(json(body)));
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }
      return json({ errcode: 'M_UNRECOGNIZED' }, 404);
    };
    const client = createClient({
      baseUrl: 'https://hs.example',
      userId: '@me:hs',
      accessToken: 'tok',
      fetchFn,
    });
    const states: SyncState[] = [];
    client.on(ClientEvent.Sync, (state) => states.push(state));
    /** Answer the latest waiting `/sync`. */
    const respond = (body: unknown) => pending.at(-1)?.(body);
    return { client, syncs, states, respond, server };
  }

  async function syncingClient() {
    const server = fakeServerClient();
    await server.client.startClient({ initialSyncLimit: 1 });
    await vi.waitFor(() => expect(server.syncs).toHaveLength(2));
    return server;
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it('resumes from the token it stopped at with a catch-up sync, never reporting itself stopped', async () => {
    const { client, syncs, states } = await syncingClient();
    try {
      pauseClientSync(client);
      await settle();

      resumeClientSync(client);

      await vi.waitFor(() => expect(syncs).toHaveLength(3));
      expect(syncs[2].get('since')).toBe('s1');
      expect(syncs[2].get('timeout')).toBe('0');
      await settle();
      expect(states).toEqual([SyncState.Prepared, SyncState.Syncing]);
      // Still connecting, so a conversation waiting for its room keeps waiting.
      expect(client.getSyncState()).toBe(SyncState.Catchup);
    } finally {
      client.stopClient();
    }
  });

  it('starts no second loop when the client is already syncing', async () => {
    const { client, syncs } = await syncingClient();
    try {
      resumeClientSync(client);
      await settle();

      expect(syncs).toHaveLength(2);
    } finally {
      client.stopClient();
    }
  });

  it('ends rapid switches with one loop and no late stop from the old one', async () => {
    const { client, syncs, states } = await syncingClient();
    try {
      pauseClientSync(client);
      resumeClientSync(client);
      pauseClientSync(client);
      resumeClientSync(client);

      await vi.waitFor(() => expect(syncs.length).toBeGreaterThan(2));
      await settle();
      expect(syncs).toHaveLength(3);
      expect(syncs[2].get('timeout')).toBe('0');
      expect(states).not.toContain(SyncState.Stopped);
      expect(client.getSyncState()).toBe(SyncState.Catchup);
    } finally {
      client.stopClient();
    }
  });

  it('waits for the old loop to finish the response it is processing', async () => {
    const { client, syncs, respond } = await syncingClient();
    let saved!: () => void;
    vi.spyOn(client.store, 'setSyncData').mockImplementationOnce(
      () => new Promise<void>((resolve) => (saved = resolve)),
    );
    try {
      respond({ next_batch: 's2' });
      await vi.waitFor(() => expect(saved).toBeDefined());

      pauseClientSync(client);
      resumeClientSync(client);
      await settle();
      expect(syncs).toHaveLength(2);

      saved();
      await vi.waitFor(() => expect(syncs).toHaveLength(3));
      expect(syncs[2].get('since')).toBe('s2');
    } finally {
      client.stopClient();
    }
  });

  it('reports a paused client as catching up, not as still syncing', async () => {
    const { client } = await syncingClient();
    try {
      pauseClientSync(client);

      expect(client.getSyncState()).toBe(SyncState.Catchup);
    } finally {
      client.stopClient();
    }
  });

  it('still resumes when the old loop dies on a store write instead of stopping', async () => {
    const { client, syncs, respond } = await syncingClient();
    let failWrite!: (error: Error) => void;
    vi.spyOn(client.store, 'setSyncData').mockImplementationOnce(
      () => new Promise<void>((_, reject) => (failWrite = reject)),
    );
    try {
      respond({ next_batch: 's2' });
      await vi.waitFor(() => expect(failWrite).toBeDefined());
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      pauseClientSync(client);
      resumeClientSync(client);
      failWrite(new Error('Connection to Indexed Database server lost'));
      await vi.advanceTimersByTimeAsync(PAUSED_LOOP_EXIT_TIMEOUT_MS);
      vi.useRealTimers();

      await vi.waitFor(() => expect(syncs).toHaveLength(3));
      expect(syncs[2].get('since')).toBe('s2');
    } finally {
      vi.useRealTimers();
      client.stopClient();
    }
  });

  it('says nothing when a resumed loop is paused during its keep-alive', async () => {
    const { client, server } = await syncingClient();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      pauseClientSync(client);
      server.pushRulesFail = true;
      server.versionsHang = true;
      resumeClientSync(client);
      // The push rules fail, so the resumed loop polls /versions until the server answers.
      await vi.advanceTimersByTimeAsync(8_000);

      pauseClientSync(client);
      await vi.advanceTimersByTimeAsync(11_000);

      expect(warn).not.toHaveBeenCalledWith(
        "Couldn't resume syncing.",
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
      client.stopClient();
    }
  });

  it('resumes a loop paused during startup only after its saved sync is replayed', async () => {
    const { client, syncs } = fakeServerClient();
    let replay!: (saved: unknown) => void;
    vi.spyOn(client.store, 'getSavedSyncToken').mockResolvedValue('s0');
    vi.spyOn(client.store, 'getSavedSync').mockReturnValue(
      new Promise((resolve) => (replay = resolve)) as never,
    );
    try {
      await client.startClient({ initialSyncLimit: 1 });
      pauseClientSync(client);
      resumeClientSync(client);
      await settle();

      replay({ nextBatch: 's0', roomsData: {}, accountData: [] });

      await vi.waitFor(() =>
        expect(syncs.some((query) => query.get('timeout') === '0')).toBe(true),
      );
      await settle();
      expect(syncs.map((query) => query.get('since'))).not.toContain(null);
    } finally {
      client.stopClient();
    }
  });

  it('leaves a stopped client stopped', async () => {
    const { client, syncs } = await syncingClient();
    client.stopClient();

    resumeClientSync(client);
    await settle();

    expect(syncs).toHaveLength(2);
  });
});
