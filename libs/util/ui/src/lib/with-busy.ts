import { DestroyRef, WritableSignal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, Observable, catchError, finalize } from 'rxjs';

/** The busy/error signals + destroy ref a page exposes for {@link runWithBusy}. */
export interface BusyState {
  busy: WritableSignal<boolean>;
  error: WritableSignal<string | null>;
  destroyRef: DestroyRef;
}

/**
 * Run a one-shot Observable with the shared busy/error convention: set `busy`,
 * clear `error`, capture the failure message (and swallow it), and reset `busy`
 * on completion or error. Tied to the component's lifetime via `destroyRef`.
 */
export function runWithBusy<T>(
  source: Observable<T>,
  state: BusyState,
): Observable<T> {
  state.busy.set(true);
  state.error.set(null);
  return source.pipe(
    takeUntilDestroyed(state.destroyRef),
    catchError((err) => {
      state.error.set(err instanceof Error ? err.message : String(err));
      return EMPTY;
    }),
    finalize(() => state.busy.set(false)),
  );
}
