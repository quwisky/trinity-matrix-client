/**
 * IndexedDB deletion primitives for the factory reset, kept pure and DI-free so the awkward
 * parts — a delete that never settles, an API that does not exist in Firefox — can be driven
 * from a spec with a fake `IDBFactory` rather than a real browser.
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
export const IDB_DELETE_TIMEOUT_MS = 5_000;

/**
 * Delete one database, resolving within `timeoutMs` no matter what.
 *
 * The bound is the entire point. `deleteDatabase` fires `onblocked` while any connection is
 * still open and then simply waits — possibly forever. matrix-js-sdk's own `clearStores`
 * handles that event by **logging and nothing else** (`client.js`), so its promise never
 * settles and the caller hangs; that is the long stall behind the "wipe" comment in
 * `MatrixClientService.removeInternal`. Here `onblocked` is a real outcome the caller can
 * report, and the timer is the backstop for the case where no event arrives at all.
 *
 * Never rejects: a factory reset reports what it could not do rather than failing halfway.
 */
export function deleteDatabase(
  idb: IDBFactory,
  name: string,
  timeoutMs: number = IDB_DELETE_TIMEOUT_MS,
): Promise<IdbDeleteOutcome> {
  return new Promise<IdbDeleteOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: IdbDeleteOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    // Armed before the request so a synchronous throw below cannot leave it dangling.
    const timer = setTimeout(() => settle('blocked'), timeoutMs);

    let request: IDBOpenDBRequest;
    try {
      request = idb.deleteDatabase(name);
    } catch {
      settle('failed');
      return;
    }
    request.onsuccess = () => settle('deleted');
    request.onerror = () => settle('failed');
    // Resolve immediately rather than waiting out the timer. Note `blocked` is NOT terminal
    // for the request itself: per spec the delete stays queued and still fires `onsuccess`
    // once the other connection closes, which for a close-pending store is milliseconds
    // away. So `blocked` means "not deleted YET, and possibly deleted a moment later" —
    // a caller must not read it as "this database survived".
    request.onblocked = () => settle('blocked');
  });
}

/**
 * Every database name on this origin, or `null` when the browser cannot enumerate them.
 *
 * `indexedDB.databases()` is unavailable in Firefox, so a caller must be able to fall back to
 * names it derived itself — `null` says "I could not look", which is different from "there
 * are none". Enumeration is still worth attempting everywhere else: it is the only way to
 * reach databases left behind by accounts that are no longer in the registry.
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
