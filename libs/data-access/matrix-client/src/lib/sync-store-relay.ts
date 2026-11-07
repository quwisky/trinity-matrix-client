import type { IndexedDBStoreWorker } from 'matrix-js-sdk/lib/indexeddb-worker';

/**
 * The SDK's worker replies `cmd_fail` only to a command that rejects; one that throws (an
 * `indexedDB.open()` refused with a SecurityError) would leave its caller waiting forever.
 */
export function relaySyncStoreCommands(
  store: IndexedDBStoreWorker,
  post: (message: unknown) => void,
): (event: MessageEvent<{ seq?: number }>) => void {
  return (event) => {
    // The SDK ignores a failed setup; thrown, it reaches the worker's error event instead.
    if ((event.data as { command?: unknown }).command === 'setupWorker') {
      store.onMessage(event);
      return;
    }
    try {
      store.onMessage(event);
    } catch (error) {
      const { name, message } = Object(error) as {
        name?: unknown;
        message?: unknown;
      };
      post({
        command: 'cmd_fail',
        seq: event.data.seq,
        error: {
          name: typeof name === 'string' ? name : 'Error',
          message: typeof message === 'string' ? message : String(error),
        },
      });
    }
  };
}
