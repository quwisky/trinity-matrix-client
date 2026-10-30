import type {
  DiagnosticAccount,
  DiagnosticNameGroup,
} from '@trinity/data-access/diagnostic-log';
import type { HomeserverInfoService } from '@trinity/data-access/homeserver';
import type { SessionEngine } from '@trinity/data-access/matrix-client';
import type { SessionStorageService } from '@trinity/platform-native';
import {
  EMPTY,
  catchError,
  defaultIfEmpty,
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

/**
 * The names a diagnostic file must replace, a group per room, from every live account's
 * engine in registry order. An account that fails is left out and the others are still read;
 * then iterating the groups throws, so the export can say that some names were not replaced.
 * IDs are redacted regardless.
 */
export function diagnosticKnownNames(
  engine: Pick<SessionEngine, 'session' | 'knownNames'>,
): Observable<Iterable<DiagnosticNameGroup>> {
  return engine.session().pipe(
    take(1),
    switchMap(({ accounts }) =>
      forkJoin(
        accounts.map(({ accountId }) =>
          engine
            .knownNames(accountId)
            .pipe(
              catchError((error: unknown) =>
                of({ ok: false, failure: error } as const),
              ),
            ),
        ),
      ).pipe(defaultIfEmpty([])),
    ),
    map((results) => ({
      [Symbol.iterator]: () => namesThenFailure(results),
    })),
  );
}

function* namesThenFailure(
  results: readonly (
    | { readonly ok: true; readonly value: readonly DiagnosticNameGroup[] }
    | { readonly ok: false; readonly failure: unknown }
  )[],
): Generator<DiagnosticNameGroup, void> {
  let failed: unknown = null;
  for (const result of results) {
    if (result.ok) {
      yield* result.value;
    } else {
      failed ??= result.failure;
    }
  }
  if (failed !== null) {
    throw new Error('The names of some accounts could not be read.', {
      cause: failed,
    });
  }
}
