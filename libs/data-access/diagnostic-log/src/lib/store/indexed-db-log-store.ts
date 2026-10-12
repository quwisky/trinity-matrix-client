import {
  DIAGNOSTIC_LOG_DB_NAME,
  deleteDatabase,
} from '@trinity/platform-native';
import {
  DIAGNOSTIC_LOG_LIMITS,
  entrySize,
  type DiagnosticEntry,
  type DiagnosticLogLimits,
} from '../diagnostic-entry.model';
import type {
  DiagnosticLogStore,
  DiagnosticStoreSnapshot,
} from './diagnostic-log-store';

const VERSION = 1;
const ENTRIES = 'entries';
const META = 'meta';
const META_KEY = 'state';

/**
 * How long opening the database may take before it counts as unusable. An open that never
 * settles (a wedged profile, a stuck upgrade) would otherwise hold the recorder's queue, and
 * with it every export, clear and delete, for good.
 */
export const IDB_CONNECT_TIMEOUT_MS = 5_000;

/** An entry as stored: its size travels with it so eviction never re-measures. */
interface StoredEntry extends DiagnosticEntry {
  readonly size: number;
}

/** Running total of stored sizes, and whether anything has been evicted since a clear. */
interface MetaState {
  readonly bytes: number;
  readonly dropped: boolean;
}

/**
 * The rolling log in IndexedDB: one database per installation, entries in insertion order
 * with a `ts` index for expiry, and a running size total so the cap never needs a scan.
 *
 * Each operation opens the database and closes it again. Holding a connection open would
 * block the factory reset's `deleteDatabase` (`LocalDataWipeService`), and a write every
 * five seconds makes the open cheap.
 */
export class IndexedDbLogStore implements DiagnosticLogStore {
  readonly kind = 'indexeddb';

  private constructor(
    private readonly idb: IDBFactory,
    private readonly name: string,
    private readonly limits: DiagnosticLogLimits,
  ) {}

  /** Open (creating) the database once to prove it works; rejects where it does not. */
  static async open(
    idb: IDBFactory | undefined,
    name = DIAGNOSTIC_LOG_DB_NAME,
    limits = DIAGNOSTIC_LOG_LIMITS,
  ): Promise<IndexedDbLogStore> {
    if (!idb) {
      throw new Error('IndexedDB is unavailable');
    }
    const store = new IndexedDbLogStore(idb, name, limits);
    (await store.connect()).close();
    return store;
  }

  append(entries: readonly DiagnosticEntry[], now: number): Promise<void> {
    if (entries.length === 0) {
      return Promise.resolve();
    }
    return this.withDb(async (db) => {
      const transaction = db.transaction([ENTRIES, META], 'readwrite');
      const completed = done(transaction);
      const store = transaction.objectStore(ENTRIES);
      const meta = transaction.objectStore(META);
      const state = (await request<MetaState | undefined>(
        meta.get(META_KEY),
      )) ?? { bytes: 0, dropped: false };

      let bytes = state.bytes;
      for (const entry of entries) {
        const size = entrySize(entry);
        bytes += size;
        store.add({ ...entry, size } satisfies StoredEntry);
      }
      const expired = await deleteWhile(
        store
          .index('ts')
          .openCursor(IDBKeyRange.upperBound(now - this.limits.maxAgeMs, true)),
        () => true,
      );
      bytes -= expired;
      const overCap = await deleteWhile(
        store.openCursor(),
        (removed) => bytes - removed > this.limits.maxBytes,
      );
      bytes -= overCap;
      meta.put(
        {
          bytes,
          dropped: state.dropped || expired + overCap > 0,
        } satisfies MetaState,
        META_KEY,
      );
      await completed;
    });
  }

  read(): Promise<DiagnosticStoreSnapshot> {
    return this.withDb(async (db) => {
      const transaction = db.transaction([ENTRIES, META], 'readonly');
      const completed = done(transaction);
      const [stored, state] = await Promise.all([
        request<StoredEntry[]>(transaction.objectStore(ENTRIES).getAll()),
        request<MetaState | undefined>(
          transaction.objectStore(META).get(META_KEY),
        ),
      ]);
      await completed;
      return {
        entries: stored.map(toEntry),
        dropped: state?.dropped ?? false,
      };
    });
  }

  clear(): Promise<void> {
    return this.withDb(async (db) => {
      const transaction = db.transaction([ENTRIES, META], 'readwrite');
      const completed = done(transaction);
      transaction.objectStore(ENTRIES).clear();
      transaction.objectStore(META).clear();
      await completed;
    });
  }

  /** Open the database, rejecting when it is refused, blocked or takes too long. */
  private connect(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let failed = false;
      const fail = (error: unknown): void => {
        if (failed) {
          return;
        }
        failed = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error('IndexedDB open timed out')),
        IDB_CONNECT_TIMEOUT_MS,
      );
      let open: IDBOpenDBRequest;
      try {
        open = this.idb.open(this.name, VERSION);
      } catch (error) {
        fail(error);
        return;
      }
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(ENTRIES)) {
          db.createObjectStore(ENTRIES, { autoIncrement: true }).createIndex(
            'ts',
            'ts',
          );
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META);
        }
      };
      open.onsuccess = () => {
        const db = open.result;
        if (failed) {
          // Already reported as failed (blocked or too late): do not leave this connection
          // holding the database.
          db.close();
          return;
        }
        clearTimeout(timer);
        // A factory reset deletes this database: never be the connection that blocks it.
        db.onversionchange = () => db.close();
        resolve(db);
      };
      open.onerror = () => fail(open.error);
      open.onblocked = () => fail(new Error('IndexedDB open blocked'));
    });
  }

  private async withDb<T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await this.connect();
    try {
      return await work(db);
    } finally {
      db.close();
    }
  }
}

/**
 * Delete the diagnostic log database, for "Keep a diagnostic log" turned off. Uses the
 * factory reset's bounded delete (`deleteDatabase` in platform-native), so a blocked delete
 * cannot hang the recorder; rejects unless the database is gone.
 */
export async function deleteIndexedDbLog(
  idb: IDBFactory | undefined,
  name = DIAGNOSTIC_LOG_DB_NAME,
): Promise<void> {
  if (!idb) {
    return;
  }
  const outcome = await deleteDatabase(idb, name);
  if (outcome !== 'deleted') {
    throw new Error(`diagnostic log not deleted: ${outcome}`);
  }
}

function toEntry(stored: StoredEntry): DiagnosticEntry {
  return {
    ts: stored.ts,
    level: stored.level,
    source: stored.source,
    logger: stored.logger,
    message: stored.message,
  };
}

function request<T>(pending: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => resolve(pending.result as T);
    pending.onerror = () => reject(pending.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  const completed = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
  // Created before the work it covers: when that work fails first, nothing awaits this and
  // the abort would surface as an unhandled rejection. The caller's `await` still sees it.
  completed.catch(() => undefined);
  return completed;
}

/** Delete under the cursor while `keepGoing(removedSoFar)` holds; resolves with the size removed. */
function deleteWhile(
  cursorRequest: IDBRequest<IDBCursorWithValue | null>,
  keepGoing: (removed: number) => boolean,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let removed = 0;
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || !keepGoing(removed)) {
        resolve(removed);
        return;
      }
      removed += (cursor.value as StoredEntry).size;
      cursor.delete();
      cursor.continue();
    };
  });
}
