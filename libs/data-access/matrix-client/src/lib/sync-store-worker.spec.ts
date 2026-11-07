import { IndexedDBStore, MemoryStore } from 'matrix-js-sdk';
import { IndexedDBStoreWorker } from 'matrix-js-sdk/lib/indexeddb-worker';
import { LocalIndexedDBStoreBackend } from 'matrix-js-sdk/lib/store/indexeddb-local-backend';
import { RemoteIndexedDBStoreBackend } from 'matrix-js-sdk/lib/store/indexeddb-remote-backend';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { relaySyncStoreCommands } from './sync-store-relay';
import {
  SYNC_STORE_REQUEST_TIMEOUT_MS,
  syncStore,
  syncStoreWorkerFactory,
} from './sync-store-worker';

interface Command {
  readonly command: string;
  readonly seq: number;
  readonly args?: unknown[];
}

/** A worker that speaks the SDK's store protocol; each test decides how it answers. */
class FakeWorker extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: Command[] = [];
  terminated = false;

  constructor(private readonly answer: (command: Command) => unknown) {
    super();
  }

  postMessage(message: Command): void {
    this.sent.push(message);
    const result = this.answer(message);
    if (result !== NO_REPLY) {
      queueMicrotask(() => this.reply(message.seq, result));
    }
  }

  reply(seq: number, result: unknown): void {
    this.deliver({ command: 'cmd_success', seq, result });
  }

  /** Like a browser: listeners and the `onmessage` handler both see the message. */
  deliver(data: unknown): void {
    const event = new MessageEvent('message', { data });
    this.dispatchEvent(event);
    this.onmessage?.(event);
  }

  /** What a browser does when the script fails to load or the worker dies. */
  crash(): void {
    const event = new ErrorEvent('error', { message: 'worker died' });
    this.dispatchEvent(event);
    this.onerror?.(event);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const NO_REPLY = Symbol('no reply');

/** Answers the startup commands, and leaves the commands named in `silent` pending. */
const healthy =
  (...silent: string[]) =>
  ({ command }: Command): unknown =>
    silent.includes(command)
      ? NO_REPLY
      : command === 'getUserPresenceEvents'
        ? []
        : undefined;

/** The main-thread fallback fails too, so a settled startup proves the fallback ran. */
const deniedIndexedDB = {
  open: () => {
    throw new Error('no IndexedDB here');
  },
} as unknown as IDBFactory;

function storeWith(worker: FakeWorker) {
  return syncStore(deniedIndexedDB, 'test', () => worker as unknown as Worker);
}

describe('syncStoreWorkerFactory', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the store on the main thread where the host has no Worker', () => {
    vi.stubGlobal('Worker', undefined);

    expect(syncStoreWorkerFactory()).toBeUndefined();
  });

  it('starts the sync store worker as a module worker', () => {
    const created: [URL, WorkerOptions | undefined][] = [];
    vi.stubGlobal(
      'Worker',
      class {
        constructor(url: URL, options?: WorkerOptions) {
          created.push([url, options]);
        }
      },
    );

    syncStoreWorkerFactory()?.();

    expect(created).toHaveLength(1);
    expect(String(created[0][0])).toMatch(/sync-store\.worker/);
    expect(created[0][1]).toEqual({ type: 'module' });
  });
});

describe('syncStore', () => {
  afterEach(() => vi.useRealTimers());

  it('falls back to the main-thread backend when the worker cannot be created', async () => {
    const store = syncStore(deniedIndexedDB, 'test', () => {
      throw new Error('worker blocked');
    });

    await expect(store.startup()).rejects.toThrow('no IndexedDB here');
    expect(store.backend).toBeInstanceOf(LocalIndexedDBStoreBackend);
  });

  it('falls back when the worker fails to load before it answers (404, CSP)', async () => {
    const worker = new FakeWorker(() => NO_REPLY);
    const store = storeWith(worker);

    const started = store.startup();
    await Promise.resolve();
    worker.crash();

    await expect(started).rejects.toThrow('no IndexedDB here');
    expect(store.backend).toBeInstanceOf(LocalIndexedDBStoreBackend);
    expect(worker.terminated).toBe(true);
  });

  it('falls back when the worker never answers', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(() => NO_REPLY);
    const store = storeWith(worker);

    const started = store.startup();
    const settled = expect(started).rejects.toThrow('no IndexedDB here');
    await vi.advanceTimersByTimeAsync(SYNC_STORE_REQUEST_TIMEOUT_MS);

    await settled;
    expect(store.backend).toBeInstanceOf(LocalIndexedDBStoreBackend);
    expect(worker.terminated).toBe(true);
  });

  it('falls back when the worker answers setup but never connects', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(healthy('connect'));
    const store = storeWith(worker);

    const started = store.startup();
    const settled = expect(started).rejects.toThrow('no IndexedDB here');
    await vi.advanceTimersByTimeAsync(SYNC_STORE_REQUEST_TIMEOUT_MS);

    await settled;
    expect(store.backend).toBeInstanceOf(LocalIndexedDBStoreBackend);
    expect(worker.terminated).toBe(true);
  });

  it('stops a worker that refused to connect once the SDK falls back', async () => {
    const worker = new FakeWorker((message) => {
      if (message.command === 'connect') {
        queueMicrotask(() =>
          worker.deliver({
            command: 'cmd_fail',
            seq: message.seq,
            error: { name: 'SecurityError', message: 'denied' },
          }),
        );
        return NO_REPLY;
      }
      return undefined;
    });
    const store = storeWith(worker);

    await expect(store.startup()).rejects.toThrow('no IndexedDB here');
    expect(store.backend).toBeInstanceOf(LocalIndexedDBStoreBackend);
    expect(worker.terminated).toBe(true);
  });

  it('fails waiting requests when the worker dies after startup', async () => {
    const worker = new FakeWorker(healthy('syncToDatabase'));
    const store = storeWith(worker);
    await store.startup();
    expect(store.backend).toBeInstanceOf(RemoteIndexedDBStoreBackend);

    const pending = store.backend.syncToDatabase([]);
    await Promise.resolve();
    worker.crash();

    await expect(pending).rejects.toThrow();
    expect(worker.terminated).toBe(true);
  });

  it('keeps sync running on the in-memory store after the worker dies', async () => {
    const worker = new FakeWorker(healthy('syncToDatabase'));
    const store = storeWith(worker);
    await store.startup();
    const degraded = vi.fn();
    store.on('degraded', degraded);

    const saved = store.save(true);
    await Promise.resolve();
    worker.crash();

    await expect(saved).resolves.toBeUndefined();
    // Later writes reject at once instead of waiting on the dead worker.
    await expect(
      store.setSyncData({ next_batch: 's1' } as never),
    ).resolves.toBeUndefined();
    expect(degraded).toHaveBeenCalled();
  });

  it('falls back when the worker stops while presence loads', async () => {
    const worker = new FakeWorker(healthy('getUserPresenceEvents'));
    const store = storeWith(worker);

    const started = store.startup();
    await vi.waitFor(() =>
      expect(worker.sent.map((m) => m.command)).toContain(
        'getUserPresenceEvents',
      ),
    );
    worker.crash();

    await expect(started).rejects.toThrow('no IndexedDB here');
    expect(store.backend).toBeInstanceOf(LocalIndexedDBStoreBackend);
    expect(worker.terminated).toBe(true);
  });

  it('stops a worker that never answers a request after startup (killed silently)', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(healthy('getSavedSync', 'syncToDatabase'));
    const store = storeWith(worker);
    await store.startup();

    const pending = store.backend.syncToDatabase([]);
    const loaded = store.getSavedSync();
    const failed = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(SYNC_STORE_REQUEST_TIMEOUT_MS);

    await failed;
    await expect(loaded).resolves.toBeNull();
    expect(worker.terminated).toBe(true);
  });

  it('switches to the in-memory store once when the worker dies', async () => {
    const worker = new FakeWorker(healthy('syncToDatabase'));
    const store = storeWith(worker);
    await store.startup();
    const degraded = vi.fn();
    store.on('degraded', degraded);
    const saved = store.save(true);
    await Promise.resolve();
    worker.crash();
    await saved;

    for (let i = 0; i < 3; i++) {
      await store.setSyncData({ next_batch: `s${i}` } as never);
      await store.save(true);
    }

    expect(degraded).toHaveBeenCalledTimes(1);
    expect(store.wantsSave()).toBe(false);
    const inFlight = (store.backend as unknown as { inFlight: object })
      .inFlight;
    expect(Object.keys(inFlight)).toHaveLength(0);
  });

  it('ends startup without reopening the database on the main thread once destroyed', async () => {
    vi.useFakeTimers();
    const open = vi.fn(() => {
      throw new Error('no IndexedDB here');
    });
    const worker = new FakeWorker(() => NO_REPLY);
    const store = syncStore(
      { open } as unknown as IDBFactory,
      'test',
      () => worker as unknown as Worker,
    );

    const started = store.startup();
    const settled = expect(started).rejects.toThrow('destroyed');
    await Promise.resolve();
    await store.destroy();
    await vi.advanceTimersByTimeAsync(SYNC_STORE_REQUEST_TIMEOUT_MS * 2);

    await settled;
    expect(open).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(true);
  });

  it('keeps a worker whose reply was queued behind a timer overdue from a suspended page', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(healthy('getSavedSync'));
    const store = storeWith(worker);
    await store.startup();

    const loaded = store.getSavedSync();
    await vi.waitFor(() =>
      expect(worker.sent.map((m) => m.command)).toContain('getSavedSync'),
    );
    const { seq } = worker.sent.find((m) => m.command === 'getSavedSync')!;
    // Suspended: the wall clock jumps and the timer comes due late, with the reply queued.
    vi.setSystemTime(Date.now() + 10 * SYNC_STORE_REQUEST_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(SYNC_STORE_REQUEST_TIMEOUT_MS);
    worker.reply(seq, null);

    await expect(loaded).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(SYNC_STORE_REQUEST_TIMEOUT_MS);
    expect(worker.terminated).toBe(false);
  });

  it('does not retry startup for a failure outside the worker', async () => {
    const open = vi.fn();
    const worker = new FakeWorker(({ command }) =>
      command === 'getUserPresenceEvents' ? [['@a:x', null]] : undefined,
    );
    const store = syncStore(
      { open } as unknown as IDBFactory,
      'test',
      () => worker as unknown as Worker,
    );

    await expect(store.startup()).rejects.toThrow('assigning it to the client');
    expect(open).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(false);
  });

  it('reaches no backend method once the worker dies', async () => {
    const worker = new FakeWorker(healthy());
    const store = storeWith(worker);
    await store.startup();
    worker.crash();
    const reached = new Error('reached the backend');
    (store as unknown as { _backend: unknown })._backend = new Proxy(
      {},
      {
        get: () => {
          throw reached;
        },
      },
    );
    // Only save() calls reallySave; the rest are lifecycle, not storage.
    const lifecycle = new Set([
      'constructor',
      'startup',
      'destroy',
      'on',
      'degradable',
      'reallySave',
    ]);
    const names = new Set([
      ...Object.getOwnPropertyNames(IndexedDBStore.prototype),
      ...Object.getOwnPropertyNames(MemoryStore.prototype),
      ...Object.keys(
        new IndexedDBStore({ indexedDB: deniedIndexedDB, dbName: 'x' }),
      ),
    ]);
    const store_ = store as unknown as Record<string, unknown>;

    const leaks: string[] = [];
    for (const name of names) {
      if (lifecycle.has(name) || typeof store_[name] !== 'function') {
        continue;
      }
      try {
        await (store_[name] as () => unknown).call(store);
      } catch (error) {
        if (error === reached) {
          leaks.push(name);
        }
      }
    }

    expect(leaks).toEqual([]);
  });

  it('clears and closes the database through the worker', async () => {
    const worker = new FakeWorker(healthy());
    const store = storeWith(worker);
    await store.startup();

    await store.deleteAllData();
    await store.destroy();

    expect(worker.sent.map((m) => m.command)).toContain('clearDatabase');
    expect(worker.terminated).toBe(true);
  });
});

describe('relaySyncStoreCommands', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lets a setupWorker throw reach the worker error event', () => {
    const posted: unknown[] = [];
    const relay = relaySyncStoreCommands(
      {
        onMessage: () => {
          throw new Error('boom');
        },
      } as unknown as IndexedDBStoreWorker,
      (message) => void posted.push(message),
    );

    expect(() =>
      relay(
        new MessageEvent('message', {
          data: { command: 'setupWorker', seq: 0, args: ['test'] },
        }),
      ),
    ).toThrow('boom');
    expect(posted).toEqual([]);
  });

  it('answers a command that throws inside the worker with cmd_fail', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('storage denied', 'SecurityError');
      },
    });
    const posted: unknown[] = [];
    const post = (message: unknown): void => void posted.push(message);
    const relay = relaySyncStoreCommands(new IndexedDBStoreWorker(post), post);

    relay(
      new MessageEvent('message', {
        data: { command: 'setupWorker', seq: 0, args: ['test'] },
      }),
    );
    relay(
      new MessageEvent('message', { data: { command: 'connect', seq: 1 } }),
    );
    await Promise.resolve();

    expect(posted).toContainEqual({
      command: 'cmd_fail',
      seq: 1,
      error: { name: 'SecurityError', message: 'storage denied' },
    });
  });
});
