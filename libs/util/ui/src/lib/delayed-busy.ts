import { type Injector, type Signal, effect, signal } from '@angular/core';

/** How long a thing must stay busy before a spinner is worth showing; below it, pure flicker. */
const DEFAULT_DELAY_MS = 150;

/**
 * How long an indicator stays once it has appeared. Without it, an operation taking 160ms would
 * show a spinner for 10ms.
 */
const DEFAULT_MINIMUM_MS = 400;

/** Tuning for {@link delayedBusy}; both are milliseconds. */
export interface DelayedBusyOptions {
  /** Wait this long before showing anything. Default {@link DEFAULT_DELAY_MS}. */
  delayMs?: number;
  /** Once shown, stay at least this long. Default {@link DEFAULT_MINIMUM_MS}. */
  minimumMs?: number;
}

/**
 * A busy signal shaped for human eyes rather than for the truth: wait a moment before showing,
 * and once shown, stay a moment. Returns a derived signal, so a template binds `showBusy()`.
 *
 * It takes an `Injector` so nothing in this library needs an injection context: the effect is
 * created with an explicit injector, so this may be called from a field initializer or a
 * method, never throws NG0203, and ties the timers to the caller's lifetime. Not from inside a
 * `computed`: `effect()` refuses to be created in a reactive context.
 */
export function delayedBusy(
  busy: Signal<boolean>,
  injector: Injector,
  options: DelayedBusyOptions = {},
): Signal<boolean> {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const minimumMs = options.minimumMs ?? DEFAULT_MINIMUM_MS;

  const visible = signal(false);
  let pending: ReturnType<typeof setTimeout> | null = null;
  let shownAt = 0;

  const clear = () => {
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
  };

  effect(
    (onCleanup) => {
      const isBusy = busy();
      // Whatever was scheduled belongs to the previous state.
      clear();

      if (isBusy) {
        if (!visible()) {
          pending = setTimeout(() => {
            pending = null;
            shownAt = Date.now();
            visible.set(true);
          }, delayMs);
        }
      } else if (visible()) {
        // Already on screen: it owes the reader the rest of its minimum before leaving.
        // Clamped to `minimumMs`: this reads the WALL clock while `setTimeout` runs on a
        // monotonic one, so an NTP correction backwards would otherwise keep the indicator
        // up for roughly the size of the jump.
        const remaining = Math.min(
          minimumMs,
          minimumMs - (Date.now() - shownAt),
        );
        if (remaining <= 0) {
          visible.set(false);
        } else {
          pending = setTimeout(() => {
            pending = null;
            visible.set(false);
          }, remaining);
        }
      }

      onCleanup(clear);
    },
    { injector },
  );

  return visible.asReadonly();
}
