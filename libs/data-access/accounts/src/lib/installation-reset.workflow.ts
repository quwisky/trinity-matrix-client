import { Injectable, inject } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  LocalDataWipeService,
  SessionStorageService,
  type AccountRecord,
} from '@trinity/platform-native';
import type { MatrixSession } from '@trinity/util/matrix';
import {
  Observable,
  catchError,
  concatMap,
  defer,
  forkJoin,
  from,
  map,
  of,
  reduce,
} from 'rxjs';
import {
  AccountCleanupAttempt,
  ownedCleanupAttempt,
} from './account-cleanup-attempt';
import { ACCOUNT_CLEANUP_STEP_BUDGET_MS } from './account-cleanup-policy';
import { ACCOUNT_LIFECYCLE_PORT } from './account-lifecycle.port';
import type {
  AccountCleanupIssue,
  AccountCleanupRecovery,
  AccountCleanupScope,
  InstallationResetOutcome,
} from './account-runtime.models';

/** Owns full-installation cleanup and safe, local-only residue retries. */
@Injectable({ providedIn: 'root' })
export class InstallationResetWorkflow {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(SessionStorageService);
  private readonly wipe = inject(LocalDataWipeService);
  private readonly lifecycle = inject(ACCOUNT_LIFECYCLE_PORT);

  reset(): Observable<InstallationResetOutcome> {
    return defer(() =>
      ownedCleanupAttempt<InstallationResetOutcome>(
        (issues, pending) => ({
          kind: 'uncertain-cleanup',
          issues,
          pending,
        }),
        (attempt) =>
          attempt
            .step(
              this.storage.list().pipe(
                catchError(() => {
                  attempt.addIssue(
                    'account-registry',
                    'retry-installation-reset',
                  );
                  return of([]);
                }),
              ),
              {
                budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.registryRead,
                scope: 'account-registry',
                recovery: 'retry-installation-reset',
                waitAfterBudget: true,
              },
            )
            .pipe(
              concatMap((records) => this.readSessions(attempt, records)),
              concatMap(({ records, sessions }) =>
                this.courtesySignOut(attempt, sessions).pipe(
                  map(() => records),
                ),
              ),
              concatMap((records) =>
                this.capture(
                  attempt,
                  this.matrix.stop(),
                  'matrix-session',
                  'restart-application',
                  ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixStop,
                ).pipe(map(() => records)),
              ),
              concatMap((records) => this.wipeIndexedDb(attempt, records)),
              concatMap(() =>
                this.capture(
                  attempt,
                  this.storage.clearAll().pipe(
                    catchError((error: unknown) => {
                      attempt.addIssue(
                        'secure-storage',
                        'retry-installation-reset',
                      );
                      throw error;
                    }),
                  ),
                  'account-registry',
                  'retry-installation-reset',
                  ACCOUNT_CLEANUP_STEP_BUDGET_MS.registryWrite,
                  () => attempt.resolveIssue('account-registry'),
                ),
              ),
              concatMap(() =>
                this.wipeKeyValueStores(attempt, {
                  secureStorage: true,
                  preferences: true,
                }),
              ),
              concatMap(() => this.wipeServiceWorker(attempt)),
            ),
        (attempt) => this.terminal(attempt),
        (attempt) => this.unexpected(attempt),
      ),
    );
  }

  /** Retry only settled local residue; server/provider effects are never repeated here. */
  retry(
    issues: readonly AccountCleanupIssue[],
  ): Observable<InstallationResetOutcome> {
    return defer(() =>
      ownedCleanupAttempt<InstallationResetOutcome>(
        (settled, pending) => ({
          kind: 'uncertain-cleanup',
          issues: settled,
          pending,
        }),
        (attempt) => {
          for (const issue of issues) {
            attempt.addIssue(issue.scope, issue.recovery);
          }
          const scopes = new Set(issues.map(({ scope }) => scope));
          const operations: Observable<unknown>[] = [];
          if (scopes.has('account-registry')) {
            operations.push(
              attempt.step(this.storage.clearAll(), {
                budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.registryWrite,
                scope: 'account-registry',
                recovery: 'retry-installation-reset',
                fallback: undefined,
                onSettled: () => attempt.resolveIssue('account-registry'),
              }),
            );
          }
          if (scopes.has('indexed-db')) {
            operations.push(this.retryIndexedDb(attempt));
          }
          if (scopes.has('secure-storage') || scopes.has('preferences')) {
            operations.push(
              this.wipeKeyValueStores(
                attempt,
                {
                  secureStorage: scopes.has('secure-storage'),
                  preferences: scopes.has('preferences'),
                },
                true,
              ),
            );
          }
          if (scopes.has('service-worker')) {
            operations.push(this.wipeServiceWorker(attempt, true));
          }
          return operations.length === 0
            ? of(void 0)
            : from(operations).pipe(concatMap((operation) => operation));
        },
        (attempt) => this.terminal(attempt),
        (attempt) => this.unexpected(attempt),
      ),
    );
  }

  private readSessions(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
    records: readonly AccountRecord[],
  ): Observable<{
    records: readonly AccountRecord[];
    sessions: readonly (MatrixSession | null)[];
  }> {
    if (records.length === 0) return of({ records, sessions: [] });
    return forkJoin(
      records.map((record) =>
        attempt.step(
          this.storage.load(record.userId).pipe(
            catchError(() => {
              attempt.addIssue('secure-storage', 'retry-installation-reset');
              if (record.oidc) {
                attempt.addIssue('provider-session', 'restart-application');
              }
              return of(null);
            }),
          ),
          {
            budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.sessionRead,
            scope: 'secure-storage',
            recovery: 'retry-installation-reset',
            fallback: null,
            onTimeout: () => {
              if (record.oidc) {
                attempt.addIssue('provider-session', 'restart-application');
              }
            },
            onSettled: (session) => {
              if (record.oidc && !session?.oidc) {
                attempt.addIssue('provider-session', 'restart-application');
              }
            },
          },
        ),
      ),
    ).pipe(map((sessions) => ({ records, sessions })));
  }

  private courtesySignOut(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
    sessions: readonly (MatrixSession | null)[],
  ): Observable<unknown> {
    const operations = [
      this.capture(
        attempt,
        this.matrix.signOutAll(),
        'matrix-session',
        'restart-application',
        ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixLogout,
      ),
      ...sessions
        .filter(
          (
            session,
          ): session is MatrixSession & {
            readonly oidc: NonNullable<MatrixSession['oidc']>;
          } => Boolean(session?.oidc),
        )
        .map((session) =>
          this.capture(
            attempt,
            this.lifecycle.revokeProviderSession(session),
            'provider-session',
            'restart-application',
            ACCOUNT_CLEANUP_STEP_BUDGET_MS.providerLogout,
          ),
        ),
    ];
    return forkJoin(operations);
  }

  private wipeIndexedDb(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
    records: readonly AccountRecord[],
  ): Observable<unknown> {
    return attempt.step(
      defer(() => from(this.wipe.beginIndexedDbWipe(records).settlement)),
      {
        budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.databaseWipe,
        scope: 'indexed-db',
        recovery: 'restart-application',
        fallback: { blocked: [], failed: [], enumerated: false },
        onSettled: (report) => {
          if (
            report.blocked.length > 0 ||
            report.failed.length > 0 ||
            !report.enumerated
          ) {
            attempt.addIssue('indexed-db', 'restart-application');
          }
        },
      },
    );
  }

  private retryIndexedDb(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
  ): Observable<unknown> {
    return attempt.step(
      defer(() => from(this.wipe.beginIndexedDbWipe([]).settlement)),
      {
        budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.databaseWipe,
        scope: 'indexed-db',
        recovery: 'retry-installation-reset',
        fallback: { blocked: [], failed: [], enumerated: false },
        onSettled: (report) => {
          if (
            report.blocked.length === 0 &&
            report.failed.length === 0 &&
            report.enumerated
          ) {
            attempt.resolveIssue('indexed-db');
          }
        },
      },
    );
  }

  private wipeKeyValueStores(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
    selected: {
      readonly secureStorage: boolean;
      readonly preferences: boolean;
    },
    resolve = false,
  ): Observable<unknown> {
    const operations: Observable<unknown>[] = [];
    let preferencesCleared: boolean | null = null;
    let webStorageCleared: boolean | null = null;
    const recordPreferences = (): void => {
      if (preferencesCleared && webStorageCleared) {
        if (resolve) attempt.resolveIssue('preferences');
      } else if (preferencesCleared === false || webStorageCleared === false) {
        attempt.addIssue('preferences', 'retry-installation-reset');
      }
    };
    if (selected.secureStorage) {
      operations.push(
        attempt.step(
          defer(() => from(this.wipe.wipeSecureStorage())),
          {
            budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.secureStorageWipe,
            scope: 'secure-storage',
            recovery: 'retry-installation-reset',
            fallback: false,
            onSettled: (succeeded) =>
              this.recordOrResolve(attempt, 'secure-storage', succeeded),
          },
        ),
      );
    }
    if (selected.preferences) {
      operations.push(
        attempt.step(
          defer(() => from(this.wipe.wipePreferences())),
          {
            budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.preferencesWipe,
            scope: 'preferences',
            recovery: 'retry-installation-reset',
            fallback: false,
            onSettled: (succeeded) => {
              preferencesCleared = succeeded;
              recordPreferences();
            },
          },
        ),
        attempt.step(
          defer(() => from(this.wipe.wipeWebStorage())),
          {
            budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.webStorageWipe,
            scope: 'preferences',
            recovery: 'retry-installation-reset',
            fallback: false,
            onSettled: (succeeded) => {
              webStorageCleared = succeeded;
              recordPreferences();
            },
          },
        ),
      );
    }
    return operations.length === 0
      ? of(void 0)
      : from(operations).pipe(
          concatMap((operation) => operation),
          reduce(() => undefined, undefined),
        );
  }

  private wipeServiceWorker(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
    resolve = false,
  ): Observable<unknown> {
    let cacheStorageCleared: boolean | null = null;
    let registrationsCleared: boolean | null = null;
    const record = (): void => {
      if (cacheStorageCleared && registrationsCleared) {
        if (resolve) attempt.resolveIssue('service-worker');
      } else if (
        cacheStorageCleared === false ||
        registrationsCleared === false
      ) {
        attempt.addIssue('service-worker', 'retry-installation-reset');
      }
    };
    return from([
      attempt.step(
        defer(() => from(this.wipe.wipeCacheStorage())),
        {
          budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.cacheStorageWipe,
          scope: 'service-worker',
          recovery: 'retry-installation-reset',
          fallback: false,
          onSettled: (succeeded) => {
            cacheStorageCleared = succeeded;
            record();
          },
        },
      ),
      attempt.step(
        defer(() => from(this.wipe.wipeServiceWorkerRegistrations())),
        {
          budgetMs:
            ACCOUNT_CLEANUP_STEP_BUDGET_MS.serviceWorkerRegistrationWipe,
          scope: 'service-worker',
          recovery: 'retry-installation-reset',
          fallback: false,
          onSettled: (succeeded) => {
            registrationsCleared = succeeded;
            record();
          },
        },
      ),
    ]).pipe(
      concatMap((operation) => operation),
      reduce(() => undefined, undefined),
    );
  }

  private recordOrResolve(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
    scope: AccountCleanupScope,
    succeeded: boolean,
  ): void {
    if (succeeded) attempt.resolveIssue(scope);
    if (!succeeded) attempt.addIssue(scope, 'retry-installation-reset');
  }

  private capture(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
    source: Observable<unknown>,
    scope: AccountCleanupScope,
    recovery: AccountCleanupRecovery,
    budgetMs: number,
    onSettled?: () => void,
  ): Observable<void> {
    return attempt
      .step(source, {
        budgetMs,
        scope,
        recovery,
        fallback: undefined,
        onSettled,
      })
      .pipe(map(() => void 0));
  }

  private terminal(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
  ): InstallationResetOutcome {
    const issues = attempt.settledIssues();
    return issues.length === 0
      ? { kind: 'ready' }
      : { kind: 'partial-cleanup', issues };
  }

  private unexpected(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
  ): InstallationResetOutcome {
    attempt.addIssue('account-registry', 'retry-installation-reset');
    return this.terminal(attempt);
  }
}
