import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticLogRecorder } from '../diagnostic-log-recorder';
import {
  IDB_CONNECT_TIMEOUT_MS,
  IndexedDbLogStore,
  deleteIndexedDbLog,
} from './indexed-db-log-store';

/** A fake IDBFactory whose open request fails the way a private window's does. */
function refusingFactory(): IDBFactory {
  return {
    open: () => {
      const request: Record<string, unknown> = {
        error: new DOMException('The operation failed', 'InvalidStateError'),
      };
      queueMicrotask(() =>
        (request['onerror'] as (() => void) | undefined)?.(),
      );
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe('IndexedDbLogStore.open', () => {
  it('refuses where IndexedDB does not exist', async () => {
    await expect(IndexedDbLogStore.open(undefined)).rejects.toThrow(
      'IndexedDB is unavailable',
    );
  });

  it('refuses when the browser rejects the database', async () => {
    await expect(
      IndexedDbLogStore.open(refusingFactory()),
    ).rejects.toBeTruthy();
  });

  it('refuses when open throws', async () => {
    const throwing = {
      open: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as IDBFactory;

    await expect(IndexedDbLogStore.open(throwing)).rejects.toBeTruthy();
  });
});

/** A fake IDBFactory whose deletes succeed (or fail), recording the names asked for. */
function deletingFactory(
  deleted: string[],
  outcome: 'success' | 'error' = 'success',
): IDBFactory {
  return {
    deleteDatabase: (name: string) => {
      deleted.push(name);
      const request: Record<string, unknown> = {};
      queueMicrotask(() =>
        (
          request[outcome === 'success' ? 'onsuccess' : 'onerror'] as
            (() => void) | undefined
        )?.(),
      );
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe('deleteIndexedDbLog', () => {
  it('deletes the diagnostic log database by name', async () => {
    const deleted: string[] = [];

    await deleteIndexedDbLog(deletingFactory(deleted));

    expect(deleted).toEqual(['trinity-diagnostic-log']);
  });

  it('rejects when the database was not deleted, and does nothing without IndexedDB', async () => {
    await expect(
      deleteIndexedDbLog(deletingFactory([], 'error')),
    ).rejects.toThrow('diagnostic log not deleted: failed');
    await expect(deleteIndexedDbLog(undefined)).resolves.toBeUndefined();
  });
});

/**
 * A fake IDBFactory that opens fine, then fails every request made in a transaction and
 * aborts it, the way a quota or storage error does.
 */
function failingTransactionFactory(close: () => void): IDBFactory {
  const failure = new DOMException('Quota', 'QuotaExceededError');
  const fail = () => {
    const request: Record<string, unknown> = { error: failure };
    setTimeout(() => (request['onerror'] as (() => void) | undefined)?.(), 0);
    return request;
  };
  const db = {
    close,
    transaction: () => {
      const transaction: Record<string, unknown> = {
        error: failure,
        objectStore: () => ({ get: fail, getAll: fail, add: fail }),
      };
      setTimeout(
        () => (transaction['onabort'] as (() => void) | undefined)?.(),
        5,
      );
      return transaction;
    },
  };
  return {
    open: () => {
      const request: Record<string, unknown> = { result: db };
      queueMicrotask(() =>
        (request['onsuccess'] as (() => void) | undefined)?.(),
      );
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe('IndexedDbLogStore operations', () => {
  const entry = {
    ts: 1,
    level: 'debug',
    source: 'sdk',
    logger: 'matrix',
    message: 'm',
  } as const;

  it.each(['append', 'read'] as const)(
    '%s rejects once when a request fails, leaving no unhandled rejection',
    async (method) => {
      const close = vi.fn();
      const store = await IndexedDbLogStore.open(
        failingTransactionFactory(close),
      );

      const result =
        method === 'append' ? store.append([entry], 1) : store.read();

      await expect(result).rejects.toThrow('Quota');
      // Let the aborting transaction report itself; Vitest fails the run on any
      // rejection nobody handled.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(close).toHaveBeenCalled();
    },
  );

  it('closes a connection that opens after the open was reported blocked', async () => {
    const close = vi.fn();
    const idb = {
      open: () => {
        const request: Record<string, unknown> = { result: { close } };
        queueMicrotask(() => {
          (request['onblocked'] as (() => void) | undefined)?.();
          (request['onsuccess'] as (() => void) | undefined)?.();
        });
        return request as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;

    await expect(IndexedDbLogStore.open(idb)).rejects.toThrow('blocked');
    await Promise.resolve();

    expect(close).toHaveBeenCalledOnce();
  });
});

/**
 * A fake IDBFactory whose open requests never settle until the test fires `succeed`, the
 * way a wedged browser profile leaves them. Each request's database records its `close`.
 */
function hangingFactory(close: () => void): {
  readonly idb: IDBFactory;
  readonly succeed: () => void;
} {
  const requests: Record<string, unknown>[] = [];
  return {
    idb: {
      open: () => {
        const request: Record<string, unknown> = { result: { close } };
        requests.push(request);
        return request as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory,
    succeed: () => {
      for (const request of requests) {
        (request['onsuccess'] as (() => void) | undefined)?.();
      }
    },
  };
}

describe('IndexedDbLogStore with an open that never settles', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses after the time limit, and closes a connection that opens later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const close = vi.fn();
    const { idb, succeed } = hangingFactory(close);

    const opened = IndexedDbLogStore.open(idb);
    const refused = expect(opened).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(IDB_CONNECT_TIMEOUT_MS);
    await refused;
    succeed();

    expect(close).toHaveBeenCalledOnce();
  });

  it('moves the recorder to memory within the time limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onStorage = vi.fn();
    const recorder = new DiagnosticLogRecorder({
      openStore: () => IndexedDbLogStore.open(hangingFactory(vi.fn()).idb),
      onStorage,
    });

    recorder.record({
      ts: Date.now(),
      level: 'info',
      source: 'app',
      logger: 'lifecycle',
      message: 'app started',
    });
    const snapshot = recorder.snapshot();
    await vi.advanceTimersByTimeAsync(IDB_CONNECT_TIMEOUT_MS);

    await expect(snapshot).resolves.toMatchObject({
      storage: 'memory',
      entries: [expect.objectContaining({ message: 'app started' })],
    });
    expect(onStorage).toHaveBeenCalledWith('memory');
  });

  it('lets discard and clear settle when the database stops opening', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const recorder = new DiagnosticLogRecorder({
      openStore: () => IndexedDbLogStore.open(hangingFactory(vi.fn()).idb),
      removeStore: () => Promise.reject(new Error('delete blocked')),
    });

    const discarded = recorder.discard().then(
      () => 'emptied',
      () => 'reported',
    );
    await vi.advanceTimersByTimeAsync(IDB_CONNECT_TIMEOUT_MS);
    await expect(discarded).resolves.toBe('reported');

    const cleared = recorder.clear();
    await vi.advanceTimersByTimeAsync(IDB_CONNECT_TIMEOUT_MS);
    await expect(cleared).resolves.toBeUndefined();
  });
});
