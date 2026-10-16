/** A coalescer: many `schedule()` calls in one task collapse into a single run. */
export interface Coalescer {
  /** Queue the callback for the end of this microtask turn, if not already queued. */
  schedule(): void;
  /** Drop a queued run (call when detaching, so it cannot fire against nothing). */
  cancel(): void;
  /** Whether a run is currently queued. Exposed for tests, not for control flow. */
  readonly pending: () => boolean;
}

/**
 * Collapse a burst of events (a /sync fires many at once) into one microtask-queued call.
 *
 * - The flag clears *before* `fn` runs, so an event arriving during the run queues the next
 *   one rather than being swallowed.
 * - {@link cancel} drops a queued run, so a detached service does not rebuild against a
 *   client it has let go of.
 *
 * In tests, flush the turn (`await Promise.resolve()`) before asserting "did NOT rebuild";
 * otherwise the assertion passes trivially.
 */
export function coalesce(fn: () => void): Coalescer {
  let scheduled = false;
  return {
    schedule(): void {
      if (scheduled) {
        return;
      }
      scheduled = true;
      queueMicrotask(() => {
        if (!scheduled) {
          return; // cancelled while queued
        }
        scheduled = false;
        fn();
      });
    },
    cancel(): void {
      scheduled = false;
    },
    pending: () => scheduled,
  };
}
