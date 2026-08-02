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
 * Collapse a burst of events into one call.
 *
 * A completed /sync fires many events at once, and rebuilding a read model — typically
 * O(rooms) plus a re-sort — once per event is waste. This queues the rebuild on the
 * microtask after the current task drains and dedupes everything that arrives meanwhile.
 *
 * Two details are load-bearing and easy to lose when reimplementing this by hand, which is
 * why it is extracted rather than described:
 *
 * - the flag clears *before* `fn` runs, so a fresh event arriving during the rebuild queues
 *   the next one rather than being swallowed;
 * - {@link cancel} drops a queued run, so a service that detaches between the schedule and
 *   the flush does not rebuild against a client it has let go of.
 *
 * Note for tests: because the run is queued rather than immediate, asserting "this did NOT
 * rebuild" passes trivially unless the turn is flushed first (`await Promise.resolve()`).
 * A negative assertion without a flush proves nothing.
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
