import { Injectable, inject } from '@angular/core';
import {
  Observable,
  TimeoutError,
  catchError,
  finalize,
  map,
  of,
  shareReplay,
  take,
  throwError,
  throwIfEmpty,
  timeout,
} from 'rxjs';
import {
  ACCOUNT_RESTORE_POLICY,
  ACCOUNT_RUNTIME_ADAPTER,
} from './account-runtime.adapter';
import type {
  AccountRestoreOutcome,
  InactiveAccountRestoreRetryOutcome,
} from './account-runtime.models';

/** Owns exact inactive-Account retry deduplication and its per-Account deadline. */
@Injectable({ providedIn: 'root' })
export class InactiveAccountRestoreWorkflow {
  private readonly adapter = inject(ACCOUNT_RUNTIME_ADAPTER);
  private readonly policy = inject(ACCOUNT_RESTORE_POLICY);
  private readonly attempts = new Map<
    string,
    Observable<InactiveAccountRestoreRetryOutcome>
  >();

  get inProgress(): boolean {
    return this.attempts.size > 0;
  }

  run(
    previous: AccountRestoreOutcome | undefined,
    publish: (outcome: AccountRestoreOutcome) => void,
  ): Observable<InactiveAccountRestoreRetryOutcome> {
    if (
      !previous ||
      previous.role !== 'inactive' ||
      previous.kind === 'ready'
    ) {
      return of({ kind: 'unavailable' });
    }
    const accountId = previous.accountId;
    const inFlight = this.attempts.get(accountId);
    if (inFlight) return inFlight;

    const startedAt = performance.now();
    const attempt = this.adapter.restoreAccount(accountId, 'inactive').pipe(
      take(1),
      throwIfEmpty(
        () => new Error('Account Runtime adapter emitted no outcome.'),
      ),
      map((outcome): AccountRestoreOutcome =>
        outcome.kind === 'failed'
          ? {
              ...outcome,
              accountId,
              role: 'inactive',
              durationMs: performance.now() - startedAt,
            }
          : {
              kind: outcome.kind,
              accountId,
              role: 'inactive',
              durationMs: performance.now() - startedAt,
            },
      ),
      timeout({ first: this.policy.timeoutMs }),
      catchError((error: unknown) =>
        error instanceof TimeoutError
          ? of({
              kind: 'timed-out' as const,
              accountId,
              role: 'inactive' as const,
              durationMs: performance.now() - startedAt,
            })
          : throwError(() => error),
      ),
      map((outcome) => {
        publish(outcome);
        return outcome;
      }),
      finalize(() => {
        if (this.attempts.get(accountId) === attempt) {
          this.attempts.delete(accountId);
        }
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    this.attempts.set(accountId, attempt);
    return attempt;
  }
}
