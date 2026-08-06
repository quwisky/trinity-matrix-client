import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteDatabase, listDatabaseNames } from './indexed-db-wipe';

/**
 * A fake `IDBFactory` whose requests fire whichever handler the test chooses — jsdom ships no
 * IndexedDB at all, and a real one could not produce the case that matters most (a delete
 * that never settles).
 */
function fakeFactory(
  fire: (request: Record<string, (() => void) | null>) => void,
): IDBFactory {
  return {
    deleteDatabase: () => {
      const request: Record<string, (() => void) | null> = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      // Handlers are attached synchronously after this returns, so defer.
      queueMicrotask(() => fire(request));
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe('deleteDatabase', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves deleted when the request succeeds', async () => {
    const idb = fakeFactory((r) => r['onsuccess']?.());

    await expect(deleteDatabase(idb, 'db')).resolves.toBe('deleted');
  });

  it('resolves failed when the request errors, without throwing', async () => {
    const idb = fakeFactory((r) => r['onerror']?.());

    await expect(deleteDatabase(idb, 'db')).resolves.toBe('failed');
  });

  it('resolves blocked as soon as onblocked fires', async () => {
    const idb = fakeFactory((r) => r['onblocked']?.());

    await expect(deleteDatabase(idb, 'db')).resolves.toBe('blocked');
  });

  it('resolves blocked at the bound when the request never settles at all', async () => {
    // THE case this helper exists for. matrix-js-sdk's own clearStores answers `onblocked`
    // by logging and nothing else, so its promise stays pending forever and the caller
    // hangs. Without this test the never-settling shape passes silently, because a
    // never-resolving promise looks exactly like a slow one.
    vi.useFakeTimers();
    const idb = fakeFactory(() => undefined); // no handler ever called

    const outcome = deleteDatabase(idb, 'db', 5_000);
    let resolved = false;
    void outcome.then(() => (resolved = true));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolved).toBe(false); // still waiting, as it should be

    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe('blocked');
  });

  it('resolves failed when deleteDatabase itself throws', async () => {
    const idb = {
      deleteDatabase: () => {
        throw new Error('SecurityError');
      },
    } as unknown as IDBFactory;

    await expect(deleteDatabase(idb, 'db')).resolves.toBe('failed');
  });

  it('clears its timer once the request settles', async () => {
    // Otherwise every delete leaves a 5s timer holding the event loop open, which turns a
    // fast wipe into a five-second pause before the restart.
    vi.useFakeTimers();
    const idb = fakeFactory((r) => r['onsuccess']?.());

    await deleteDatabase(idb, 'db', 5_000);

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('listDatabaseNames', () => {
  it('returns the names when the browser can enumerate', async () => {
    const idb = {
      databases: async () => [{ name: 'a' }, { name: 'b' }],
    } as unknown as IDBFactory;

    await expect(listDatabaseNames(idb)).resolves.toEqual(['a', 'b']);
  });

  it('returns null — not an empty list — when databases() is unavailable', async () => {
    // Firefox has no indexedDB.databases(). The distinction is load-bearing: an empty list
    // means "nothing to delete", null means "I could not look, use the names you derived",
    // and confusing the two would silently skip the wipe on that browser.
    const idb = {} as unknown as IDBFactory;

    await expect(listDatabaseNames(idb)).resolves.toBeNull();
  });

  it('returns null when enumeration rejects', async () => {
    const idb = {
      databases: async () => {
        throw new Error('nope');
      },
    } as unknown as IDBFactory;

    await expect(listDatabaseNames(idb)).resolves.toBeNull();
  });
});
