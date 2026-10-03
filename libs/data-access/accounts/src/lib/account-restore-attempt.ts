import {
  Observable,
  TimeoutError,
  catchError,
  map,
  of,
  take,
  throwError,
  throwIfEmpty,
  timeout,
} from 'rxjs';
import type {
  AccountRestorePolicy,
  AccountRuntimeAdapter,
} from './account-runtime.adapter';
import type {
  AccountRestoreOutcome,
  AccountRestoreRole,
} from './account-runtime.models';
import { accountRestoreOutcomeFor } from './account-restore-results';

/** One cold Account restoration attempt with the shared typed deadline. */
export function restoreAccountWithinPolicy(
  adapter: AccountRuntimeAdapter,
  policy: AccountRestorePolicy,
  accountId: string,
  role: AccountRestoreRole,
): Observable<AccountRestoreOutcome> {
  return new Observable<AccountRestoreOutcome>((subscriber) => {
    return adapter
      .restoreAccount(accountId, role)
      .pipe(
        take(1),
        throwIfEmpty(
          () => new Error('Account Runtime adapter emitted no outcome.'),
        ),
        map((outcome) => accountRestoreOutcomeFor(accountId, role, outcome)),
        timeout({ first: policy.timeoutMs }),
        catchError((error: unknown) =>
          error instanceof TimeoutError
            ? of({
                kind: 'timed-out' as const,
                accountId,
                role,
              })
            : throwError(() => error),
        ),
      )
      .subscribe(subscriber);
  });
}
