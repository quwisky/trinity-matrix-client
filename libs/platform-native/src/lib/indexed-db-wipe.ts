/**
 * IndexedDB deletion primitives for the factory reset, pure and DI-free so a spec can
 * drive a delete that never settles, or a missing `databases()`, with a fake `IDBFactory`.
 */

/** How a single `deleteDatabase` attempt ended. */
export type IdbDeleteOutcome =
  /** Gone, or never existed. */
  | 'deleted'
  /** Another connection (a second tab, a store that did not close) is holding it open. */
  | 'blocked'
  /** The request errored. */
  | 'failed';

/** Default bound for one delete. Deletes run in parallel, so this bounds the whole phase. */
const IDB_DELETE_TIMEOUT_MS = 5_000;

export interface IdbDeleteAttempt {
  /** Bounded first observation; `blocked` does not claim the request was cancelled. */
  readonly observation: Promise<IdbDeleteOutcome>;
  /** Actual request settlement; may resolve after `observation` or remain pending. */
  readonly settlement: Promise<Exclude<IdbDeleteOutcome, 'blocked'>>;
}

/**
 * Delete one database, resolving within `timeoutMs` no matter what.
 *
 * The bound is the point. `deleteDatabase` fires `onblocked` while any connection is
 * still open and then waits, possibly forever. matrix-js-sdk's own `clearStores` only
 * logs that event, so its promise never settles and the caller hangs. Here `onblocked`
 * is an outcome the caller can report, and the timer backstops the case where no event
 * arrives at all.
 *
 * Never rejects: a factory reset reports what it could not do rather than failing halfway.
 */
export function deleteDatabase(
  idb: IDBFactory,
  name: string,
  timeoutMs: number = IDB_DELETE_TIMEOUT_MS,
): Promise<IdbDeleteOutcome> {
  return beginDatabaseDeletion(idb, name, timeoutMs).observation;
}

/** Begin one deletion while keeping its real settlement distinct from bounded observation. */
export function beginDatabaseDeletion(
  idb: IDBFactory,
  name: string,
  timeoutMs: number = IDB_DELETE_TIMEOUT_MS,
): IdbDeleteAttempt {
  let observe!: (outcome: IdbDeleteOutcome) => void;
  let settle!: (outcome: 'deleted' | 'failed') => void;
  let observed = false;
  let settled = false;
  const observation = new Promise<IdbDeleteOutcome>((resolve) => {
    observe = (outcome) => {
      if (observed) return;
      observed = true;
      clearTimeout(timer);
      resolve(outcome);
    };
  });
  const settlement = new Promise<'deleted' | 'failed'>((resolve) => {
    settle = (outcome) => {
      if (settled) return;
      settled = true;
      observe(outcome);
      resolve(outcome);
    };
  });
  // Armed before the request so a synchronous throw below cannot leave observation dangling.
  const timer = setTimeout(() => observe('blocked'), timeoutMs);
  let request: IDBOpenDBRequest;
  try {
    request = idb.deleteDatabase(name);
  } catch {
    settle('failed');
    return { observation, settlement };
  }
  request.onsuccess = () => settle('deleted');
  request.onerror = () => settle('failed');
  // `blocked` is only an observation: the queued request remains owned until success/error.
  request.onblocked = () => observe('blocked');
  return { observation, settlement };
}

/**
 * Every database name on this origin, or `null` when the browser cannot enumerate them.
 *
 * `indexedDB.databases()` is unavailable in Firefox, so callers must fall back to names
 * they derived themselves: `null` means "could not look", not "there are none".
 * Elsewhere enumeration is the only way to reach databases left by accounts no longer in
 * the registry.
 */
export async function listDatabaseNames(
  idb: IDBFactory,
): Promise<string[] | null> {
  if (typeof idb.databases !== 'function') {
    return null;
  }
  try {
    const databases = await idb.databases();
    return databases
      .map((info) => info.name)
      .filter((name): name is string => typeof name === 'string');
  } catch {
    return null;
  }
}
