/**
 * The mention index's IndexedDB database (`@trinity/data-access/notifications`). Named here,
 * with the other databases the factory reset deletes by name, because a browser without
 * `indexedDB.databases()` (Firefox) offers no other way to find it.
 */
export const MENTION_INDEX_DB_NAME = 'trinity-mention-index';
