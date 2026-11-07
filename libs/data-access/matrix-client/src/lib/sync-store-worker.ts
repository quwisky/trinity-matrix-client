import { IndexedDBStore, MemoryStore } from 'matrix-js-sdk';
import { RemoteIndexedDBStoreBackend } from 'matrix-js-sdk/lib/store/indexeddb-remote-backend';

/**
 * A worker request unanswered by then means the worker is dead: an OS-killed WebView worker
 * often fires no error event. Generous: a 28 MB cache loads in the worker in under 0.2 s.
 */
export const SYNC_STORE_REQUEST_TIMEOUT_MS = 30_000;

const WORKER_STOPPED = 'The sync store worker stopped.';

/** The store methods that reach the backend, swapped for MemoryStore's once the worker dies. */
const BACKEND_METHODS = [
  'getSavedSync',
  'isNewlyCreated',
  'getSavedSyncToken',
  'deleteAllData',
  'setSyncData',
  'getOutOfBandMembers',
  'setOutOfBandMembers',
  'clearOutOfBandMembers',
  'getClientOptions',
  'storeClientOptions',
  'wantsSave',
  'save',
  'saveToDeviceBatches',
  'getOldestToDeviceBatch',
  'removeToDeviceBatch',
] as const satisfies readonly (keyof MemoryStore & keyof IndexedDBStore)[];

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
 * The account's sync store, in a worker where the host allows one. A worker that fails or
 * stops answering during startup leaves the store on the main thread; one that does later
 * fails its waiting requests and the store continues in memory, so sync carries on.
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
  private started = false;
  private destroyed = false;
  private readonly watchdogs = new Map<number, ReturnType<typeof setTimeout>>();

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
    try {
      await super.startup();
    } catch (error) {
      if (
        !(this.backend instanceof RemoteIndexedDBStoreBackend) ||
        this.destroyed
      ) {
        throw error;
      }
      // The SDK falls back only when connect fails; with the worker stopped, a second
      // attempt's connect fails at once and takes that path.
      this.stopWorker();
      await super.startup();
    } finally {
      // The SDK swaps in the main-thread backend without stopping the worker it gave up on.
      if (!(this.backend instanceof RemoteIndexedDBStoreBackend)) {
        this.stopWorker();
      }
    }
    this.started = this.backend instanceof RemoteIndexedDBStoreBackend;
  }

  override destroy(): Promise<void> {
    // A removed account's store must not fall back and reopen its database.
    this.destroyed = true;
    this.clearWatchdogs();
    return super.destroy();
  }

  private watch(worker: Worker): Worker {
    this.worker = worker;
    const stop = (): void => this.stopWorker();
    worker.addEventListener('error', stop);
    worker.addEventListener('messageerror', stop);
    worker.addEventListener('message', ({ data }: MessageEvent) => {
      this.answered = true;
      const seq = (data as { seq?: unknown }).seq;
      if (typeof seq === 'number') {
        clearTimeout(this.watchdogs.get(seq));
        this.watchdogs.delete(seq);
      }
    });
    const post = worker.postMessage.bind(worker) as (message: unknown) => void;
    worker.postMessage = (message: { seq?: unknown }) => {
      post(message);
      if (typeof message.seq === 'number' && !this.destroyed) {
        this.watchdogs.set(
          message.seq,
          setTimeout(() => this.stopWorker(), SYNC_STORE_REQUEST_TIMEOUT_MS),
        );
      }
    };
    return worker;
  }

  /** Stop the worker and fail everything waiting on it, now and later, instead of hanging. */
  private stopWorker(): void {
    const worker = this.worker;
    if (!worker) {
      return;
    }
    this.worker = null;
    this.clearWatchdogs();
    worker.terminate();
    // The SDK keeps posting to this worker; each later request is rejected (and dropped) at once.
    worker.postMessage = () =>
      queueMicrotask(() => rejectInFlight(this.backend));
    // Before the first answer only the SDK's start waits, and only its error handler rejects it.
    worker.onerror?.call(
      worker,
      new ErrorEvent('error', { message: WORKER_STOPPED }),
    );
    if (this.answered) {
      rejectInFlight(this.backend);
    }
    if (this.started) {
      this.useMemory();
    }
  }

  /** Degrade once, as the SDK's per-call fallback would on every call after a failure. */
  private useMemory(): void {
    const store = this as unknown as Record<string, unknown>;
    for (const name of BACKEND_METHODS) {
      store[name] = MemoryStore.prototype[name];
    }
  }

  private clearWatchdogs(): void {
    for (const timer of this.watchdogs.values()) {
      clearTimeout(timer);
    }
    this.watchdogs.clear();
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
