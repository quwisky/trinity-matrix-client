import { IndexedDBStore } from 'matrix-js-sdk';
import { RemoteIndexedDBStoreBackend } from 'matrix-js-sdk/lib/store/indexeddb-remote-backend';

/**
 * A worker that has not loaded the sync cache by then is treated as dead, so the SDK loads
 * it on the main thread instead. Generous: a large cache loads in the worker in well under 1s.
 */
export const SYNC_STORE_STARTUP_TIMEOUT_MS = 30_000;

const WORKER_STOPPED = 'The sync store worker stopped.';

/**
 * Runs the sync store in a worker so loading and saving the sync cache stay off the main
 * thread. Undefined where the host has no Worker.
 */
export function syncStoreWorkerFactory(): (() => Worker) | undefined {
  if (typeof Worker === 'undefined') {
    return undefined;
  }
  return () =>
    new Worker(new URL('./sync-store.worker', import.meta.url), {
      type: 'module',
    });
}

/**
 * The account's sync store, in a worker where the host allows one. A worker that fails to
 * start, connect or answer in time leaves the store on the main thread; one that dies later
 * fails its waiting requests, so the SDK degrades the store to memory and sync carries on.
 */
export function syncStore(
  indexedDB: IDBFactory,
  dbName: string,
  createWorker = syncStoreWorkerFactory(),
): IndexedDBStore {
  return new WorkerSyncStore(indexedDB, dbName, createWorker);
}

class WorkerSyncStore extends IndexedDBStore {
  private worker: Worker | null = null;
  private answered = false;

  constructor(
    indexedDB: IDBFactory,
    dbName: string,
    createWorker: (() => Worker) | undefined,
  ) {
    let watch = (worker: Worker): Worker => worker;
    super({
      indexedDB,
      dbName,
      workerFactory: createWorker && (() => watch(createWorker())),
    });
    watch = (worker) => this.watch(worker);
  }

  override async startup(): Promise<void> {
    const timer = setTimeout(
      () => this.stopWorker(),
      SYNC_STORE_STARTUP_TIMEOUT_MS,
    );
    try {
      await super.startup();
    } finally {
      clearTimeout(timer);
      // The SDK swaps in the main-thread backend without stopping the worker it gave up on.
      if (!(this.backend instanceof RemoteIndexedDBStoreBackend)) {
        this.stopWorker();
      }
    }
  }

  private watch(worker: Worker): Worker {
    this.worker = worker;
    const stop = (): void => this.stopWorker();
    worker.addEventListener('error', stop);
    worker.addEventListener('messageerror', stop);
    worker.addEventListener('message', () => (this.answered = true), {
      once: true,
    });
    return worker;
  }

  /** Stop the worker and fail everything waiting on it, now and later, instead of hanging. */
  private stopWorker(): void {
    const worker = this.worker;
    if (!worker) {
      return;
    }
    this.worker = null;
    worker.terminate();
    // The SDK keeps posting to this worker; a throw rejects each later request at once.
    worker.postMessage = () => {
      throw new Error(WORKER_STOPPED);
    };
    // Before the first answer only the SDK's start waits, and only its error handler rejects it.
    worker.onerror?.call(
      worker,
      new ErrorEvent('error', { message: WORKER_STOPPED }),
    );
    if (this.answered) {
      rejectInFlight(this.backend);
    }
  }
}

/**
 * shortcut: reads the SDK's private request table, which has no public way to fail; the spec
 * drives the real backend, so an SDK upgrade that renames it fails there.
 */
function rejectInFlight(backend: unknown): void {
  if (!(backend instanceof RemoteIndexedDBStoreBackend)) {
    return;
  }
  const inFlight = (
    backend as unknown as {
      inFlight?: Record<number, { reject(reason: unknown): void }>;
    }
  ).inFlight;
  for (const [seq, request] of Object.entries(inFlight ?? {})) {
    delete inFlight?.[Number(seq)];
    request.reject(new Error(WORKER_STOPPED));
  }
}
