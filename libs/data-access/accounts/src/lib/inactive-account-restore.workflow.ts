import { Injectable, inject } from '@angular/core';
import { Observable, finalize, map, of, shareReplay } from 'rxjs';
import {
  ACCOUNT_RESTORE_POLICY,
  ACCOUNT_RUNTIME_ADAPTER,
} from './account-runtime.adapter';
import type {
  AccountRestoreOutcome,
  InactiveAccountRestoreRetryOutcome,
} from './account-runtime.models';
import { restoreAccountWithinPolicy } from './account-restore-attempt';

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

    const attempt = restoreAccountWithinPolicy(
      this.adapter,
      this.policy,
      accountId,
      'inactive',
    ).pipe(
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
