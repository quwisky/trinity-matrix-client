import type { DiagnosticAccount } from '@trinity/data-access/diagnostic-log';
import type { HomeserverInfoService } from '@trinity/data-access/homeserver';
import type { SessionStorageService } from '@trinity/platform-native';
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

/** How long the export waits for a homeserver's software probe before calling it unknown. */
export const DIAGNOSTIC_PROBE_BUDGET_MS = 3_000;

/**
 * The signed-in accounts for the diagnostic log header, active first: the account registry
 * (user ID, device ID, base URL; never a token) plus what each homeserver says it runs.
 * Completes once; a probe that fails or exceeds the budget leaves the software unknown.
 */
export function diagnosticAccounts(
  sessions: Pick<SessionStorageService, 'snapshot'>,
  homeservers: Pick<HomeserverInfoService, 'load' | 'infos'>,
  budgetMs = DIAGNOSTIC_PROBE_BUDGET_MS,
): Observable<readonly DiagnosticAccount[]> {
  return sessions.snapshot().pipe(
    take(1),
    switchMap(({ activeAccountId, accounts }) => {
      const ordered = [...accounts].sort(
        (left, right) =>
          Number(right.userId === activeAccountId) -
          Number(left.userId === activeAccountId),
      );
      if (ordered.length === 0) {
        return of<readonly DiagnosticAccount[]>([]);
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
          ordered.map((account): DiagnosticAccount => {
            const software = homeservers.infos().get(account.userId)?.software;
            return {
              userId: account.userId,
              deviceId: account.deviceId || null,
              homeserverUrl: account.baseUrl,
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
