import { Observable } from 'rxjs';

/** How long one slice of export work may hold the main thread. */
export const EXPORT_SLICE_MS = 8;

export interface SliceOptions {
  /** The longest a slice runs before yielding; {@link EXPORT_SLICE_MS} by default. */
  readonly sliceMs?: number;
  /** The clock slices are measured on; `performance.now` by default. */
  readonly now?: () => number;
}

/**
 * Run `work` a slice at a time, yielding to the event loop between slices so input and
 * rendering go on while it runs. Each `yield` in `work` marks a point where it may pause;
 * its return value is emitted. The first slice runs on subscription, so short work needs no
 * yield. Cold; unsubscribing stops it between two steps and runs no further.
 */
export function runInSlices<T>(
  work: () => Iterator<void, T>,
  options: SliceOptions = {},
): Observable<T> {
  const sliceMs = options.sliceMs ?? EXPORT_SLICE_MS;
  const now = options.now ?? (() => performance.now());
  return new Observable<T>((subscriber) => {
    const steps = work();
    let cancelNext: (() => void) | null = null;
    const slice = (): void => {
      cancelNext = null;
      const deadline = now() + sliceMs;
      try {
        for (;;) {
          const step = steps.next();
          if (step.done) {
            subscriber.next(step.value);
            subscriber.complete();
            return;
          }
          if (now() >= deadline) {
            break;
          }
        }
      } catch (error) {
        subscriber.error(error);
        return;
      }
      cancelNext = nextTask(slice);
    };
    slice();
    return () => {
      cancelNext?.();
      steps.return?.(undefined as T);
    };
  });
}

/**
 * Run `run` in a later task: a `MessageChannel` message, which unlike `setTimeout(0)` is not
 * clamped to 4 ms once nested, or a timer where there is none. Returns a cancel.
 */
function nextTask(run: () => void): () => void {
  if (typeof MessageChannel === 'undefined') {
    const timer = setTimeout(run, 0);
    return () => clearTimeout(timer);
  }
  const channel = new MessageChannel();
  const close = (): void => {
    channel.port1.close();
    channel.port2.close();
  };
  channel.port1.onmessage = () => {
    close();
    run();
  };
  channel.port2.postMessage(null);
  return close;
}

/** Run `work` to the end at once: the same steps, for callers that can wait. */
export function runToEnd<T>(work: Iterator<void, T>): T {
  for (;;) {
    const step = work.next();
    if (step.done) {
      return step.value;
    }
  }
}
