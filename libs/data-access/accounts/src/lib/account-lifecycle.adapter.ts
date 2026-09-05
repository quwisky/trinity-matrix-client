import { Injectable, inject } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import {
  Observable,
  catchError,
  concatMap,
  defer,
  from,
  map,
  of,
  reduce,
  switchMap,
  tap,
} from 'rxjs';
import {
  AccountCleanupAttempt,
  ownedCleanupAttempt,
} from './account-cleanup-attempt';
import { ACCOUNT_CLEANUP_STEP_BUDGET_MS } from './account-cleanup-policy';
import { ACCOUNT_LIFECYCLE_PORT } from './account-lifecycle.port';
import {
  AccountSignOutRetryWorkflow,
  type SignOutRetryContext,
} from './account-sign-out-retry.workflow';
import type {
  AccountCleanupIssue,
  AccountCleanupRecovery,
  AccountCleanupScope,
  AccountSignOutOutcome,
  InstallationResetOutcome,
} from './account-runtime.models';
import { InstallationResetWorkflow } from './installation-reset.workflow';

/** Matrix-backed Account-removal workflow kept separate from restore and establishment. */
@Injectable({ providedIn: 'root' })
export class AccountLifecycleAdapter {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(SessionStorageService);
  private readonly lifecycle = inject(ACCOUNT_LIFECYCLE_PORT);
  private readonly installationReset = inject(InstallationResetWorkflow);
  private readonly signOutRetry = inject(AccountSignOutRetryWorkflow);

  signOutAccount(accountId: string): Observable<AccountSignOutOutcome> {
    return defer(() => {
      let terminalOverride: AccountSignOutOutcome | null = null;
      let remainingAccountIds: readonly string[] = [];
      let retryContext: SignOutRetryContext | null = null;
      return ownedCleanupAttempt<AccountSignOutOutcome>(
        (issues, pending) => ({
          kind: 'uncertain-cleanup',
          accountId,
          issues,
          pending,
        }),
        (attempt) =>
          attempt
            .step(
              this.storage.list().pipe(
                map((accounts) => ({ kind: 'available' as const, accounts })),
                catchError(() => of({ kind: 'unavailable' as const })),
              ),
              {
                budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.registryRead,
                scope: 'account-registry',
                recovery: 'retry-sign-out',
                waitAfterBudget: true,
              },
            )
            .pipe(
              switchMap((registry) => {
                if (registry.kind === 'unavailable') {
                  terminalOverride = {
                    kind: 'failed',
                    accountId,
                    failure: 'local-state-unavailable',
                    recovery: 'retry-sign-out',
                  };
                  return of(void 0);
                }
                if (
                  !registry.accounts.some((entry) => entry.userId === accountId)
                ) {
                  terminalOverride = {
                    kind: 'failed',
                    accountId,
                    failure: 'account-unavailable',
                    recovery: 'retry-sign-out',
                  };
                  return of(void 0);
                }
                remainingAccountIds = registry.accounts
                  .map((entry) => entry.userId)
                  .filter((id) => id !== accountId);
                retryContext = {
                  accountId,
                  remainingAccountIds,
                  client: this.matrix.clientFor(accountId),
                  providerExpected: Boolean(
                    registry.accounts.find(
                      (entry) => entry.userId === accountId,
                    )?.oidc,
                  ),
                  session: null,
                };
                return this.runSignOut(attempt, retryContext);
              }),
            ),
        (attempt) => {
          if (terminalOverride) return terminalOverride;
          const issues = attempt.settledIssues();
          const liveActive = this.matrix.activeUserId();
          const activeAccountId =
            liveActive && remainingAccountIds.includes(liveActive)
              ? liveActive
              : (remainingAccountIds[0] ?? null);
          const base = { accountId, activeAccountId, remainingAccountIds };
          if (issues.length === 0) {
            this.signOutRetry.clear(accountId);
            return { kind: 'ready', ...base };
          }
          if (retryContext) this.signOutRetry.retain(retryContext);
          return { kind: 'partial-cleanup', ...base, issues };
        },
        () => ({
          kind: 'failed',
          accountId,
          failure: 'local-state-unavailable',
          recovery: 'retry-sign-out',
        }),
      );
    });
  }

  /** Retry only residue retained by a settled removal attempt. */
  retrySignOutCleanup(
    accountId: string,
    issues: readonly AccountCleanupIssue[],
  ): Observable<AccountSignOutOutcome> {
    return this.signOutRetry.retry(accountId, issues);
  }

  resetInstallation(): Observable<InstallationResetOutcome> {
    return this.installationReset.reset();
  }

  retryInstallationCleanup(
    issues: readonly AccountCleanupIssue[],
  ): Observable<InstallationResetOutcome> {
    return this.installationReset.retry(issues);
  }

  private runSignOut(
    attempt: AccountCleanupAttempt<AccountSignOutOutcome>,
    context: SignOutRetryContext,
  ): Observable<unknown> {
    const { accountId, remainingAccountIds } = context;
    const serverLogout$ = context.client
      ? defer(() => from(context.client!.logout(true)))
      : of(void 0);
    return attempt
      .step(
        this.storage.load(accountId).pipe(
          catchError(() => {
            attempt.addIssue('secure-storage', 'retry-sign-out');
            if (context.providerExpected) {
              attempt.addIssue('provider-session', 'restart-application');
            }
            return of(null);
          }),
        ),
        {
          budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.sessionRead,
          scope: 'secure-storage',
          recovery: 'retry-sign-out',
          fallback: null,
          onTimeout: () => {
            if (context.providerExpected) {
              attempt.addIssue('provider-session', 'retry-sign-out');
            }
          },
          onSettled: (session) => {
            context.session = session;
            if (!context.providerExpected) {
              attempt.resolveIssue('provider-session');
            } else if (!session?.oidc) {
              attempt.addIssue('provider-session', 'restart-application');
            }
          },
        },
      )
      .pipe(
        switchMap((session) =>
          from([
            this.capture(
              attempt,
              remainingAccountIds.length === 0
                ? this.lifecycle.unregisterNotifications()
                : this.lifecycle.unregisterNotifications(accountId),
              'notifications',
              'retry-sign-out',
              ACCOUNT_CLEANUP_STEP_BUDGET_MS.notificationUnregister,
            ),
            ...(session?.oidc
              ? [
                  this.capture(
                    attempt,
                    this.lifecycle.revokeProviderSession(session),
                    'provider-session',
                    'retry-sign-out',
                    ACCOUNT_CLEANUP_STEP_BUDGET_MS.providerLogout,
                  ),
                ]
              : []),
            this.capture(
              attempt,
              serverLogout$,
              'matrix-session',
              'retry-sign-out',
              ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixLogout,
            ),
          ]).pipe(concatMap((operation) => operation)),
        ),
        reduce(() => undefined, undefined),
        concatMap(() =>
          remainingAccountIds.length === 0
            ? this.clearLastAccount(attempt, accountId)
            : this.removeOneAccount(attempt, accountId, remainingAccountIds),
        ),
      );
  }

  private clearLastAccount(
    attempt: AccountCleanupAttempt<AccountSignOutOutcome>,
    accountId: string,
  ): Observable<void> {
    return this.capture(
      attempt,
      this.matrix.remove(accountId),
      'crypto-and-cache',
      'restart-application',
      ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixStop,
    ).pipe(
      tap(() => this.clearSharedAccountState(attempt)),
      concatMap(() =>
        this.capture(
          attempt,
          this.storage.clear(),
          'account-registry',
          'retry-sign-out',
          ACCOUNT_CLEANUP_STEP_BUDGET_MS.registryWrite,
          () => attempt.resolveIssue('secure-storage'),
        ),
      ),
    );
  }

  private removeOneAccount(
    attempt: AccountCleanupAttempt<AccountSignOutOutcome>,
    accountId: string,
    remainingAccountIds: readonly string[],
  ): Observable<void> {
    return this.capture(
      attempt,
      this.matrix.remove(accountId),
      'crypto-and-cache',
      'restart-application',
      ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixStop,
    ).pipe(
      tap(() => this.clearDrafts(attempt)),
      concatMap(() =>
        this.capture(
          attempt,
          this.storage.remove(accountId),
          'account-registry',
          'retry-sign-out',
          ACCOUNT_CLEANUP_STEP_BUDGET_MS.registryWrite,
          () => attempt.resolveIssue('secure-storage'),
        ),
      ),
      concatMap(() => {
        const currentActive = this.matrix.activeUserId();
        const active =
          currentActive && remainingAccountIds.includes(currentActive)
            ? currentActive
            : (remainingAccountIds[0] ?? null);
        if (
          active &&
          active !== currentActive &&
          this.matrix.clientFor(active)
        ) {
          this.matrix.setActive(active);
        }
        return active
          ? this.capture(
              attempt,
              this.storage.setActive(active),
              'account-registry',
              'retry-sign-out',
              ACCOUNT_CLEANUP_STEP_BUDGET_MS.registryWrite,
            )
          : of(void 0);
      }),
    );
  }

  private clearSharedAccountState(
    attempt: AccountCleanupAttempt<AccountSignOutOutcome>,
  ): void {
    try {
      this.lifecycle.releaseSharedCaches();
    } catch {
      attempt.addIssue('crypto-and-cache', 'restart-application');
    }
    this.clearDrafts(attempt);
  }

  private clearDrafts(
    attempt: AccountCleanupAttempt<AccountSignOutOutcome>,
  ): void {
    try {
      this.lifecycle.clearDrafts();
    } catch {
      attempt.addIssue('drafts', 'retry-sign-out');
    }
  }

  private capture<TOutcome>(
    attempt: AccountCleanupAttempt<TOutcome>,
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
}
