import {
  MENTION_INDEX_DB_NAME,
  deleteDatabase,
} from '@trinity/platform-native';
import {
  MENTION_MAX_AGE_MS,
  rowsPastLimits,
  type MentionCursor,
  type MentionIndexStore,
  type MentionRecord,
} from './mention-index-store';

const VERSION = 1;
const MENTIONS = 'mentions';
const BY_TIME = 'byTime';

/** An open that never settles would hold every caller behind it for good. */
export const MENTION_IDB_CONNECT_TIMEOUT_MS = 5_000;

interface StoredMention extends MentionRecord {
  readonly accountId: string;
}

/** Every `byTime` key of one account, from `[accountId]` up to any ts and eventId. */
const firstErrors = new WeakMap<IDBTransaction, unknown>();

/**
 * The `byTime` range a page reads, or null when nothing can be in it: `before` already
 * lies under the age floor, where `IDBKeyRange.bound` would throw a `DataError`.
 */
export function pageRange(
  accountId: string,
  before: MentionCursor | null,
  now: number,
): IDBKeyRange | null {
  const floor = now - MENTION_MAX_AGE_MS;
  if (before && before.ts < floor) {
    return null;
  }
  return IDBKeyRange.bound(
    [accountId, floor],
    before ? [accountId, before.ts, before.eventId] : [accountId, Infinity, []],
    false,
    before !== null,
  );
}

/** Throws a `TypeError` for a record the index could never page or prune. */
export function assertStorable(record: MentionRecord): void {
  if (
    typeof record.ts !== 'number' ||
    !Number.isFinite(record.ts) ||
    !record.eventId ||
    !record.roomId
  ) {
    throw new TypeError('Invalid mention record');
  }
}

function accountTimes(accountId: string): IDBKeyRange {
  return IDBKeyRange.bound([accountId], [accountId, Infinity, []]);
}

/**
 * The mention index in IndexedDB: one database for every account, rows keyed by
 * `[accountId, eventId]`. Each operation opens and closes the database, so a wipe's
 * `deleteDatabase` is never blocked (as the diagnostic log's store does).
 */
export class IndexedDbMentionStore implements MentionIndexStore {
  constructor(
    private readonly idb: IDBFactory | undefined,
    private readonly name = MENTION_INDEX_DB_NAME,
  ) {}

  put(accountId: string, record: MentionRecord, now: number): Promise<void> {
    try {
      assertStorable(record);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.withDb(async (db) => {
      const transaction = db.transaction(MENTIONS, 'readwrite');
      const completed = done(transaction);
      const store = transaction.objectStore(MENTIONS);
      try {
        store.put({
          accountId,
          eventId: record.eventId,
          roomId: record.roomId,
          ts: record.ts,
        } satisfies StoredMention);
        const rows = await request<StoredMention[]>(
          store.index(BY_TIME).getAll(accountTimes(accountId)),
        );
        for (const eventId of rowsPastLimits(rows, now)) {
          store.delete([accountId, eventId]);
        }
      } catch (error) {
        // The put's own failure (quota) aborts the transaction; the later request only
        // reports an AbortError.
        throw firstErrors.get(transaction) ?? error;
      }
      await completed;
    });
  }

  page(
    accountId: string,
    before: MentionCursor | null,
    limit: number,
    now: number,
  ): Promise<readonly MentionRecord[]> {
    return this.withDb(async (db) => {
      const transaction = db.transaction(MENTIONS, 'readonly');
      const completed = done(transaction);
      const range = pageRange(accountId, before, now);
      if (!range) {
        await completed;
        return [];
      }
      const found: MentionRecord[] = [];
      const cursorRequest = transaction
        .objectStore(MENTIONS)
        .index(BY_TIME)
        .openCursor(range, 'prev');
      await new Promise<void>((resolve, reject) => {
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || found.length >= limit) {
            resolve();
            return;
          }
          const { eventId, roomId, ts } = cursor.value as StoredMention;
          found.push({ eventId, roomId, ts });
          cursor.continue();
        };
      });
      await completed;
      return found;
    });
  }

  remove(accountId: string, eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) {
      return Promise.resolve();
    }
    return this.withDb(async (db) => {
      const transaction = db.transaction(MENTIONS, 'readwrite');
      const completed = done(transaction);
      const store = transaction.objectStore(MENTIONS);
      for (const eventId of eventIds) {
        store.delete([accountId, eventId]);
      }
      await completed;
    });
  }

  count(accountId?: string): Promise<number> {
    return this.withDb(async (db) => {
      const transaction = db.transaction(MENTIONS, 'readonly');
      const completed = done(transaction);
      const store = transaction.objectStore(MENTIONS);
      const total = await request<number>(
        accountId === undefined
          ? store.count()
          : store.index(BY_TIME).count(accountTimes(accountId)),
      );
      await completed;
      return total;
    });
  }

  clearAccount(accountId: string): Promise<void> {
    return this.withDb(async (db) => {
      const transaction = db.transaction(MENTIONS, 'readwrite');
      const completed = done(transaction);
      transaction
        .objectStore(MENTIONS)
        .delete(IDBKeyRange.bound([accountId], [accountId, []]));
      await completed;
    });
  }

  keepOnlyAccounts(accountIds: readonly string[]): Promise<void> {
    return this.withDb(async (db) => {
      const transaction = db.transaction(MENTIONS, 'readwrite');
      const completed = done(transaction);
      const cursorRequest = transaction.objectStore(MENTIONS).openCursor();
      await new Promise<void>((resolve, reject) => {
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            resolve();
            return;
          }
          if (!accountIds.includes((cursor.value as StoredMention).accountId)) {
            cursor.delete();
          }
          cursor.continue();
        };
      });
      await completed;
    });
  }

  async deleteAll(): Promise<void> {
    if (!this.idb) {
      throw new Error('IndexedDB is unavailable');
    }
    const outcome = await deleteDatabase(this.idb, this.name);
    if (outcome !== 'deleted') {
      throw new Error(`mention index not deleted: ${outcome}`);
    }
  }

  /** Open the database, rejecting when it is absent, refused, blocked or too slow. */
  private connect(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const idb = this.idb;
      if (!idb) {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }
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
        MENTION_IDB_CONNECT_TIMEOUT_MS,
      );
      let open: IDBOpenDBRequest;
      try {
        open = idb.open(this.name, VERSION);
      } catch (error) {
        fail(error);
        return;
      }
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(MENTIONS)) {
          db.createObjectStore(MENTIONS, {
            keyPath: ['accountId', 'eventId'],
          }).createIndex(BY_TIME, ['accountId', 'ts', 'eventId']);
        }
      };
      open.onsuccess = () => {
        const db = open.result;
        if (failed) {
          db.close();
          return;
        }
        clearTimeout(timer);
        // A wipe deletes this database: never be the connection that blocks it.
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

function request<T>(pending: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => resolve(pending.result as T);
    pending.onerror = () => reject(pending.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  const completed = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    // A request error bubbles here while `transaction.error` is still null; keep it.
    transaction.addEventListener('error', (event) => {
      if (!firstErrors.has(transaction)) {
        firstErrors.set(transaction, (event.target as IDBRequest).error);
      }
    });
    transaction.onabort = () =>
      reject(
        firstErrors.get(transaction) ??
          transaction.error ??
          new Error('IndexedDB transaction aborted'),
      );
  });
  // Created before the work it covers: when that work fails first nothing awaits this yet.
  completed.catch(() => undefined);
  return completed;
}
