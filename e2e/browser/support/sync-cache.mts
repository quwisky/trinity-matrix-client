import { expect, type Page } from '../../fixtures.mts';

/**
 * Wait until the SDK has persisted a sync for this user to its IndexedDB store, so the next
 * load restores it from cache (a returning user) rather than starting cold.
 *
 * The SDK writes that store after its first sync and then at most every five minutes, so a
 * room or space joined after this returns is missing from the cache a reload replays until
 * the next write. A journey that relies on that has to finish within those five minutes.
 */
export async function waitForPersistedSync(
  page: Page,
  user: string,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (localpart) => {
          const dbs = await indexedDB.databases();
          const name = dbs
            .map((d) => d.name ?? '')
            .find((n) => n.includes(`trinity-sync:@${localpart}:`));
          if (!name) return false;
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(name);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          try {
            if (!db.objectStoreNames.contains('sync')) return false;
            const saved = await new Promise<unknown>((resolve, reject) => {
              const req = db
                .transaction('sync', 'readonly')
                .objectStore('sync')
                .get(['-']); // keyPath ["clobber"]: an array key
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            return !!(saved as { nextBatch?: string } | undefined)?.nextBatch;
          } finally {
            db.close();
          }
        }, user),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/**
 * Hold every `/sync` request the page sends until `release()`, so the app runs on what its
 * sync cache restores. Install it before the navigation it should affect.
 */
export async function holdSync(
  page: Page,
): Promise<{ readonly release: () => void }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/_matrix/client/**/sync*', async (route) => {
    await gate;
    // A request from before a reload has no page to answer any more.
    await route.continue().catch(() => undefined);
  });
  return { release };
}
