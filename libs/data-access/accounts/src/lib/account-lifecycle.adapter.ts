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
  runDetachedCleanupAttempt,
} from './account-cleanup-attempt';
import { ACCOUNT_CLEANUP_STEP_BUDGET_MS } from './account-cleanup-policy';
import { ACCOUNT_LIFECYCLE_PORT } from './account-lifecycle.port';
import { accountSignOutSettlement } from './account-sign-out-outcome';
import {
  AccountSignOutRetryWorkflow,
  remoteLogout,
  remoteLogoutScope,
  type SignOutRetryContext,
} from './account-sign-out-retry.workflow';
import type {
  AccountCleanupIssue,
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
      return runDetachedCleanupAttempt<AccountSignOutOutcome>(
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
          const outcome = accountSignOutSettlement(
            this.matrix.activeUserId(),
            { accountId, remainingAccountIds },
            issues,
          );
          if (issues.length === 0) {
            this.signOutRetry.clear(accountId);
            return outcome;
          }
          if (retryContext) this.signOutRetry.retain(retryContext);
          return outcome;
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
    // A live client carries its own tokens; only without one does revoking at the
    // provider depend on reading the stored session.
    const providerNeedsSession = context.providerExpected && !context.client;
    // The push handoff goes first, while the token it holds is still valid: once a
    // later step revokes it, a lingering copy would only sit in the native store.
    return attempt
      .capture(
        this.lifecycle.forgetPushHandoff(accountId),
        'notifications',
        'retry-sign-out',
        ACCOUNT_CLEANUP_STEP_BUDGET_MS.notificationUnregister,
      )
      .pipe(
        concatMap(() =>
          attempt.step(
            this.storage.load(accountId).pipe(
              catchError(() => {
                attempt.addIssue('secure-storage', 'retry-sign-out');
                if (providerNeedsSession) {
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
                if (providerNeedsSession) {
                  attempt.addIssue('provider-session', 'retry-sign-out');
                }
              },
              onSettled: (session) => {
                context.session = session;
                // Never resolves: a late read must not erase a failed revocation.
                if (providerNeedsSession && !session?.oidc) {
                  attempt.addIssue('provider-session', 'restart-application');
                }
              },
            },
          ),
        ),
        switchMap(() =>
          from([
            attempt.capture(
              remainingAccountIds.length === 0
                ? this.lifecycle.unregisterNotifications()
                : this.lifecycle.unregisterNotifications(accountId),
              'notifications',
              'retry-sign-out',
              ACCOUNT_CLEANUP_STEP_BUDGET_MS.notificationUnregister,
            ),
            // One remote step. A separate provider revocation would revoke every OAuth
            // token twice now that logout() does it.
            attempt.capture(
              remoteLogout(context, this.matrix),
              remoteLogoutScope(context),
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
    return attempt
      .capture(
        this.matrix.remove(accountId),
        'crypto-and-cache',
        'restart-application',
        ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixStop,
      )
      .pipe(
        tap(() => this.clearSharedAccountState(attempt)),
        concatMap(() =>
          attempt.capture(
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
    return attempt
      .capture(
        this.matrix.remove(accountId),
        'crypto-and-cache',
        'restart-application',
        ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixStop,
      )
      .pipe(
        tap(() => this.clearDrafts(attempt)),
        concatMap(() =>
          attempt.capture(
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
            ? attempt.capture(
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
}
