/**
 * Runs the sync store in a worker so loading and saving the sync cache stay off the main
 * thread. Undefined where the host has no Worker; a worker that fails to start or connect
 * makes the SDK fall back to the main-thread store.
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
