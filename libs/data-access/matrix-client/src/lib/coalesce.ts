/** A coalescer: many `schedule()` calls in one task (or delay window) collapse into a single run. */
export interface Coalescer {
  /** Queue the callback, if not already queued. */
  schedule(): void;
  /** Run a queued callback now instead of when its turn or delay ends. */
  flush(): void;
  /** Drop a queued run (call when detaching, so it cannot fire against nothing). */
  cancel(): void;
  /** Whether a run is currently queued. Exposed for tests, not for control flow. */
  readonly pending: () => boolean;
}

/**
 * Collapse a burst of events (a /sync fires many at once) into one call, queued on a microtask
 * or, with `delayMs`, on a timer that fires at most that long after the first event. The delay
 * is for sources that emit across several tasks; a timer keeps running in a hidden tab, where
 * `requestAnimationFrame` would not.
 *
 * - The flag clears *before* `fn` runs, so an event arriving during the run queues the next
 *   one rather than being swallowed.
 * - {@link Coalescer.cancel} drops a queued run, so a detached service does not rebuild
 *   against a client it has let go of.
 *
 * In tests, flush the turn (`await Promise.resolve()`, or advance the timers for a delay)
 * before asserting "did NOT rebuild"; otherwise the assertion passes trivially.
 */
export function coalesce(fn: () => void, delayMs?: number): Coalescer {
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    scheduled = false;
    clearTimeout(timer);
    timer = undefined;
  };
  const flush = (): void => {
    if (!scheduled) {
      return; // nothing queued, or cancelled while queued
    }
    cancel();
    fn();
  };
  return {
    schedule(): void {
      if (scheduled) {
        return;
      }
      scheduled = true;
      if (delayMs === undefined) {
        queueMicrotask(flush);
      } else {
        timer = setTimeout(flush, delayMs);
      }
    },
    flush,
    cancel,
    pending: () => scheduled,
  };
}
