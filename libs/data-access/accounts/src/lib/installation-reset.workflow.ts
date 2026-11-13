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
  defaultIfEmpty,
  defer,
  forkJoin,
  from,
  map,
  of,
  reduce,
  take,
  timeout,
} from 'rxjs';
import {
  AccountCleanupAttempt,
  runDetachedCleanupAttempt,
} from './account-cleanup-attempt';
import { ACCOUNT_CLEANUP_STEP_BUDGET_MS } from './account-cleanup-policy';
import { ACCOUNT_LIFECYCLE_PORT } from './account-lifecycle.port';
import type {
  AccountCleanupIssue,
  AccountCleanupScope,
  InstallationResetOutcome,
} from './account-runtime.models';

interface BooleanCleanupOperation {
  readonly run: () => Promise<boolean>;
  readonly budgetMs: number;
}

/** Owns full-installation cleanup and safe, local-only residue retries. */
@Injectable({ providedIn: 'root' })
export class InstallationResetWorkflow {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(SessionStorageService);
  private readonly wipe = inject(LocalDataWipeService);
  private readonly lifecycle = inject(ACCOUNT_LIFECYCLE_PORT);
  /** The last reset deleted nothing, so the retry that follows it is a whole reset. */
  private refused = false;

  reset(): Observable<InstallationResetOutcome> {
    return defer(() =>
      runDetachedCleanupAttempt<InstallationResetOutcome>(
        (issues, pending) => ({
          kind: 'uncertain-cleanup',
          issues,
          pending,
        }),
        (attempt) =>
          defer(() => from(this.wipe.keychainAwaitingHost())).pipe(
            catchError(() => of(false)),
            concatMap((awaitingHost) => {
              this.refused = awaitingHost;
              if (!awaitingHost) return this.erase(attempt);
              // Before anything is deleted: the stores would go and their accounts stay.
              attempt.addIssue('secure-storage', 'retry-installation-reset');
              return of(void 0);
            }),
          ),
        (attempt) => this.terminal(attempt),
        (attempt) => this.unexpected(attempt),
      ),
    );
  }

  private erase(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
  ): Observable<unknown> {
    return (
      // Empties the push handoff before anything can invalidate the tokens it holds.
      attempt
        .capture(
          this.lifecycle.forgetPushHandoff(),
          'notifications',
          'restart-application',
          ACCOUNT_CLEANUP_STEP_BUDGET_MS.notificationUnregister,
        )
        .pipe(
          concatMap(() =>
            attempt.step(
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
            ),
          ),
          concatMap((records) => this.readSessions(attempt, records)),
          concatMap(({ records, sessions }) =>
            this.courtesySignOut(attempt, sessions).pipe(map(() => records)),
          ),
          concatMap((records) =>
            attempt
              .capture(
                this.matrix.stop(),
                'matrix-session',
                'restart-application',
                ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixStop,
              )
              .pipe(map(() => records)),
          ),
          concatMap((records) => {
            this.clearDrafts(attempt);
            return this.stopMentionIndex().pipe(
              concatMap(() => this.wipeSharedFiles(attempt)),
              map(() => records),
            );
          }),
          concatMap((records) =>
            this.wipeIndexedDb(attempt, records).pipe(map(() => records)),
          ),
          concatMap((records) =>
            attempt
              .capture(
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
              )
              .pipe(map(() => records)),
          ),
          concatMap((records) =>
            this.wipeKeyValueStores(
              attempt,
              { secureStorage: true, preferences: true },
              false,
              records,
            ),
          ),
          concatMap(() => this.wipeServiceWorker(attempt)),
        )
    );
  }

  /** Retry only settled local residue; server/provider effects are never repeated here. */
  retry(
    issues: readonly AccountCleanupIssue[],
  ): Observable<InstallationResetOutcome> {
    return defer(() =>
      this.refused
        ? this.reset()
        : runDetachedCleanupAttempt<InstallationResetOutcome>(
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
              if (scopes.has('shared-files')) {
                operations.push(this.wipeSharedFiles(attempt));
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
    // Read here, not in the callbacks: a late read settles after stop() has emptied the targets.
    const signedOut = this.matrix.reauthTargets();
    return forkJoin(
      records.map((record) => {
        // A re-auth target's tokens are already gone.
        const providerExpected =
          record.oidc && !signedOut.includes(record.userId);
        // A retry repeats no server effect, so a password session nothing could read to
        // sign out waits for a restart too. A live client is signed out without the read.
        const logoutExpected =
          !record.oidc &&
          !signedOut.includes(record.userId) &&
          !this.matrix.clientFor(record.userId);
        return attempt.step(
          this.storage.load(record.userId).pipe(
            catchError(() => {
              attempt.addIssue('secure-storage', 'retry-installation-reset');
              if (providerExpected) {
                attempt.addIssue('provider-session', 'restart-application');
              }
              if (logoutExpected) {
                attempt.addIssue('matrix-session', 'restart-application');
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
              if (providerExpected) {
                attempt.addIssue('provider-session', 'restart-application');
              }
              if (logoutExpected) {
                attempt.addIssue('matrix-session', 'restart-application');
              }
            },
            onSettled: (session) => {
              if (providerExpected && !session?.oidc) {
                attempt.addIssue('provider-session', 'restart-application');
              }
            },
          },
        );
      }),
    ).pipe(map((sessions) => ({ records, sessions })));
  }

  private courtesySignOut(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
    sessions: readonly (MatrixSession | null)[],
  ): Observable<unknown> {
    const operations = [
      attempt.capture(
        this.lifecycle.unregisterNotifications(),
        'notifications',
        'restart-application',
        ACCOUNT_CLEANUP_STEP_BUDGET_MS.notificationUnregister,
      ),
      attempt.capture(
        this.matrix.signOutAll(),
        'matrix-session',
        'restart-application',
        ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixLogout,
      ),
      // signOutAll reaches live clients only; a stored session whose restore failed still
      // holds a valid token. OAuth sessions are revoked at their provider below.
      ...sessions
        .filter(
          (session): session is MatrixSession =>
            session !== null &&
            !session.oidc &&
            !this.matrix.clientFor(session.userId),
        )
        .map((session) =>
          attempt.capture(
            defer(() =>
              from(this.matrix.detachedClient(session).logout(true)),
            ).pipe(catchError(() => of(void 0))),
            'matrix-session',
            'restart-application',
            ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixLogout,
          ),
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
          attempt.capture(
            this.lifecycle.revokeProviderSession(session),
            'provider-session',
            'restart-application',
            ACCOUNT_CLEANUP_STEP_BUDGET_MS.providerLogout,
          ),
        ),
    ];
    return forkJoin(operations);
  }

  /**
   * Empty the drafts held in memory as well as on disk: the preferences wipe removes only the
   * stored copy, and a later write, a session handover's flush included, would put it back.
   * Once the clients have stopped, so no composer is left to save one again.
   */
  private clearDrafts(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
  ): void {
    try {
      this.lifecycle.clearDrafts();
    } catch {
      attempt.addIssue('drafts', 'restart-application');
    }
  }

  /** Stop recording before the wipe, or a pending write would recreate the store. */
  private stopMentionIndex(): Observable<void> {
    return this.bounded(defer(() => this.lifecycle.stopMentionIndex()));
  }

  private wipeSharedFiles(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
  ): Observable<unknown> {
    return attempt.step(
      defer(() => from(this.wipe.wipeSharedFiles())),
      {
        budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.sharedFilesWipe,
        scope: 'shared-files',
        recovery: 'retry-installation-reset',
        fallback: false,
        onSettled: (succeeded) =>
          this.recordOrResolve(attempt, 'shared-files', succeeded),
      },
    );
  }

  private bounded(source: Observable<void>): Observable<void> {
    return source.pipe(
      take(1),
      timeout({
        first: ACCOUNT_CLEANUP_STEP_BUDGET_MS.mentionIndexStop,
        with: () => of(void 0),
      }),
      catchError(() => of(void 0)),
      defaultIfEmpty(void 0),
      map(() => void 0),
    );
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
    records?: readonly AccountRecord[],
  ): Observable<unknown> {
    const operations: Observable<unknown>[] = [];
    // Secure storage first: on web its keys are Preferences entries under a `secure.`
    // prefix, so clearing the group first would leave the sweep nothing to find.
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
        this.keepsRegistry(attempt, records).pipe(
          concatMap((keep) => {
            if (keep) {
              attempt.addIssue('preferences', 'retry-installation-reset');
              return of(void 0);
            }
            return this.wipePair(
              attempt,
              'preferences',
              [
                {
                  run: () => this.wipe.wipePreferences(),
                  budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.preferencesWipe,
                },
                {
                  run: () => this.wipe.wipeWebStorage(),
                  budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.webStorageWipe,
                },
              ],
              resolve,
            );
          }),
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

  /**
   * Whether the Preferences wipe must wait for a registry clear that failed or is still
   * running. Only on the desktop keychain, where the registry (a Preferences entry) is the
   * one map to the entries left: wiping it would strand them beyond any later erase.
   * Elsewhere the wipe or the sweep reaches them without it. A registry that cannot be read
   * or names nothing is no map, so it never holds the wipe back. `records` is what this
   * attempt read; a retry reads again.
   */
  private keepsRegistry(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
    records?: readonly AccountRecord[],
  ): Observable<boolean> {
    return defer(() => {
      const running = attempt.pendingScopes().includes('account-registry');
      const failed = attempt
        .settledIssues()
        .some(({ scope }) => scope === 'account-registry');
      if (!running && !failed) return of(false);
      return from(this.wipe.secretsRemovedByNameOnly()).pipe(
        concatMap((byNameOnly) => {
          if (!byNameOnly) return of(false);
          if (records) return of(records.length > 0);
          // The clear still running holds the registry; a read would queue behind it.
          if (running) return of(true);
          return this.storage.list().pipe(map((read) => read.length > 0));
        }),
      );
    }).pipe(
      take(1),
      // Unknown in time wipes: the erase must always be able to finish.
      timeout({
        first: ACCOUNT_CLEANUP_STEP_BUDGET_MS.registryRead,
        with: () => of(false),
      }),
      catchError(() => of(false)),
      defaultIfEmpty(false),
    );
  }

  private wipeServiceWorker(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
    resolve = false,
  ): Observable<unknown> {
    return this.wipePair(
      attempt,
      'service-worker',
      [
        {
          run: () => this.wipe.wipeCacheStorage(),
          budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.cacheStorageWipe,
        },
        {
          run: () => this.wipe.wipeServiceWorkerRegistrations(),
          budgetMs:
            ACCOUNT_CLEANUP_STEP_BUDGET_MS.serviceWorkerRegistrationWipe,
        },
      ],
      resolve,
    );
  }

  private wipePair(
    attempt: AccountCleanupAttempt<InstallationResetOutcome>,
    scope: AccountCleanupScope,
    operations: readonly [BooleanCleanupOperation, BooleanCleanupOperation],
    resolve: boolean,
  ): Observable<unknown> {
    const settlements: (boolean | null)[] = [null, null];
    const record = (index: number, succeeded: boolean): void => {
      settlements[index] = succeeded;
      if (settlements.every((settlement) => settlement === true)) {
        if (resolve) attempt.resolveIssue(scope);
      } else if (settlements.some((settlement) => settlement === false)) {
        attempt.addIssue(scope, 'retry-installation-reset');
      }
    };
    return from(
      operations.map(({ run, budgetMs }, index) =>
        attempt.step(
          defer(() => from(run())),
          {
            budgetMs,
            scope,
            recovery: 'retry-installation-reset',
            fallback: false,
            onSettled: (succeeded) => record(index, succeeded),
          },
        ),
      ),
    ).pipe(
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
