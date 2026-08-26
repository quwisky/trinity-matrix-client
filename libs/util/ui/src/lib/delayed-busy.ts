import { type Injector, type Signal, effect, signal } from '@angular/core';

/**
 * How long a thing must stay busy before it is worth telling anyone about.
 *
 * Below this, the operation finishes before a person can register that anything appeared,
 * so a spinner is pure flicker — a flash that draws the eye to a thing that is already done.
 */
const DEFAULT_DELAY_MS = 150;

/**
 * How long an indicator stays once it has appeared, even if the work finishes sooner.
 *
 * Without this, the delay above just moves the flicker: an operation taking 160ms shows a
 * spinner for 10ms. Anything that appears has to stay long enough to be read as a state
 * rather than a glitch.
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
 * A busy signal shaped for human eyes rather than for the truth.
 *
 * `busy` is a fact about the program: it flips the instant a request starts and the instant
 * it ends. Bound straight to a spinner it produces the two failure modes everyone has seen —
 * a flash on every fast request, and a spinner that vanishes before you can tell what it
 * was. The fix is the same everywhere and was previously written out per site, or more often
 * not written at all: wait a moment before showing, and once shown, stay a moment.
 *
 * Returns a derived signal, so a template binds `showBusy()` and nothing else changes.
 *
 * ## Why it takes an Injector
 *
 * This library's contract is that nothing in it needs an INJECTION CONTEXT — the reason
 * `runWithBusy` and `mediaQuerySignal` take a `DestroyRef` rather than reaching for one. An
 * `Injector` passed as an argument keeps that property exactly: the effect below is created
 * with an explicit injector, so this can be called from a field initializer or a method
 * rather than only from a constructor, and can never throw NG0203. Not from inside a
 * `computed`, though — `effect()` refuses to be created in a reactive context, and no
 * injector argument changes that. It is also what ties the timers to the caller's lifetime —
 * when the injector's scope is destroyed the effect is torn down and the cleanup runs.
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
      // Whatever was scheduled was scheduled for the previous state; the state just
      // changed, so it is answering a question nobody is asking any more.
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
        //
        // Clamped to `minimumMs`, because this reads the WALL clock while `setTimeout` runs
        // on a monotonic one. An NTP correction backwards mid-operation makes the elapsed
        // time negative, and without the clamp the indicator would sit there for roughly the
        // size of the jump — half a minute, for a half-minute correction.
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
