/**
 * The diagnostic log's IndexedDB database (`@trinity/data-access/diagnostic-log`). Named
 * here, with the other databases the factory reset deletes by name, because a browser
 * without `indexedDB.databases()` (Firefox) offers no other way to find it.
 */
export const DIAGNOSTIC_LOG_DB_NAME = 'trinity-diagnostic-log';
