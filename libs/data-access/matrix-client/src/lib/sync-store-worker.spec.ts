import { IndexedDBStore } from 'matrix-js-sdk';
import { LocalIndexedDBStoreBackend } from 'matrix-js-sdk/lib/store/indexeddb-local-backend';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { syncStoreWorkerFactory } from './sync-store-worker';

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

  it('falls back to the main-thread backend when the worker cannot start', async () => {
    const store = new IndexedDBStore({
      // A main-thread open that fails too, so startup settles without a real IndexedDB.
      indexedDB: {
        open: () => {
          throw new Error('no IndexedDB here');
        },
      } as unknown as IDBFactory,
      dbName: 'fallback-test',
      workerFactory: () => {
        throw new Error('worker blocked');
      },
    });

    await expect(store.startup()).rejects.toThrow('no IndexedDB here');
    expect(store.backend).toBeInstanceOf(LocalIndexedDBStoreBackend);
  });
});
