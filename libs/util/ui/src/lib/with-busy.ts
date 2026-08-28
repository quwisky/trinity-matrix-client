import { DestroyRef, WritableSignal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, Observable, catchError, defer, finalize } from 'rxjs';

/** The busy/error signals + destroy ref a page exposes for {@link runWithBusy}. */
export interface BusyState {
  busy: WritableSignal<boolean>;
  error: WritableSignal<string | null>;
  destroyRef: DestroyRef;
  /** Present the captured error without relying on a component render pass. */
  presentError?: () => void;
}

/** Optional operation-specific error handling for {@link runWithBusy}. */
export interface BusyErrorHandling {
  formatError?: (error: unknown) => string;
  reportError?: (error: unknown) => void;
}

/**
 * Run a one-shot Observable with the shared busy/error convention: set `busy`,
 * clear `error`, capture the failure message (and swallow it), and reset `busy`
 * on completion or error. Tied to the component's lifetime via `destroyRef`.
 */
export function runWithBusy<T>(
  source: Observable<T>,
  state: BusyState,
  errorHandling: BusyErrorHandling = {},
): Observable<T> {
  return defer(() => {
    state.busy.set(true);
    state.error.set(null);
    return source.pipe(
      takeUntilDestroyed(state.destroyRef),
      catchError((err: unknown) => {
        try {
          errorHandling.reportError?.(err);
        } catch {
          // Reporting is diagnostic only and must never keep a request surface stuck.
        }
        let message = err instanceof Error ? err.message : String(err);
        if (errorHandling.formatError) {
          try {
            message = errorHandling.formatError(err);
          } catch {
            // Preserve the existing fallback if an operation formatter is faulty.
          }
        }
        state.error.set(message);
        try {
          state.presentError?.();
        } catch {
          // Presentation is best-effort and must not turn a handled failure into a crash.
        }
        return EMPTY;
      }),
      finalize(() => state.busy.set(false)),
    );
  });
}
