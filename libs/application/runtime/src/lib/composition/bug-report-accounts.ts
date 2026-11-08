import type { HomeserverInfoService } from '@trinity/data-access/homeserver';
import type {
  BugReportAccount,
  SessionStorageService,
} from '@trinity/platform-native';
import {
  EMPTY,
  catchError,
  endWith,
  forkJoin,
  ignoreElements,
  map,
  of,
  switchMap,
  take,
  timeout,
  type Observable,
} from 'rxjs';

/** How long a bug report waits for a homeserver's software probe before calling it unknown. */
export const BUG_REPORT_PROBE_BUDGET_MS = 3_000;

/**
 * What each signed-in account's homeserver says it runs, active account first, for a bug
 * report's facts.
 * Completes once; a probe that fails or exceeds the budget leaves the software unknown.
 */
export function bugReportAccounts(
  sessions: Pick<SessionStorageService, 'snapshot'>,
  homeservers: Pick<HomeserverInfoService, 'load' | 'infos'>,
  budgetMs = BUG_REPORT_PROBE_BUDGET_MS,
): Observable<readonly BugReportAccount[]> {
  return sessions.snapshot().pipe(
    take(1),
    switchMap(({ activeAccountId, accounts }) => {
      const ordered = [...accounts].sort(
        (left, right) =>
          Number(right.userId === activeAccountId) -
          Number(left.userId === activeAccountId),
      );
      if (ordered.length === 0) {
        return of<readonly BugReportAccount[]>([]);
      }
      return forkJoin(
        ordered.map((account) =>
          homeservers.load(account.userId).pipe(
            timeout({ first: budgetMs, with: () => EMPTY }),
            catchError(() => EMPTY),
            ignoreElements(),
            endWith(undefined),
          ),
        ),
      ).pipe(
        map(() =>
          ordered.map((account): BugReportAccount => {
            const software = homeservers.infos().get(account.userId)?.software;
            return {
              software: software
                ? { name: software.name, version: software.version }
                : null,
            };
          }),
        ),
      );
    }),
  );
}
