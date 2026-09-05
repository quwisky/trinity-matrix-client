import { Injectable, inject } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import type { MatrixSession } from '@trinity/util/matrix';
import { Observable, concatMap, defer, from, of, reduce } from 'rxjs';
import {
  AccountCleanupAttempt,
  ownedCleanupAttempt,
} from './account-cleanup-attempt';
import { ACCOUNT_CLEANUP_STEP_BUDGET_MS } from './account-cleanup-policy';
import { ACCOUNT_LIFECYCLE_PORT } from './account-lifecycle.port';
import type {
  AccountCleanupIssue,
  AccountCleanupScope,
  AccountSignOutOutcome,
} from './account-runtime.models';

export interface SignOutRetryContext {
  readonly accountId: string;
  readonly remainingAccountIds: readonly string[];
  readonly client: ReturnType<MatrixClientService['clientFor']>;
  readonly providerExpected: boolean;
  session: MatrixSession | null;
}

/** Retains only the context required to retry settled, safe Account-removal residue. */
@Injectable({ providedIn: 'root' })
export class AccountSignOutRetryWorkflow {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(SessionStorageService);
  private readonly lifecycle = inject(ACCOUNT_LIFECYCLE_PORT);
  private readonly residue = new Map<string, SignOutRetryContext>();

  retain(context: SignOutRetryContext): void {
    this.residue.set(context.accountId, context);
  }

  clear(accountId: string): void {
    this.residue.delete(accountId);
  }

  retry(
    accountId: string,
    issues: readonly AccountCleanupIssue[],
  ): Observable<AccountSignOutOutcome> {
    return defer(() => {
      const context = this.residue.get(accountId);
      if (!context) {
        return of({
          kind: 'failed' as const,
          accountId,
          failure: 'account-unavailable' as const,
          recovery: 'retry-sign-out' as const,
        });
      }
      return ownedCleanupAttempt<AccountSignOutOutcome>(
        (settled, pending) => ({
          kind: 'uncertain-cleanup',
          accountId,
          issues: settled,
          pending,
        }),
        (attempt) => this.run(attempt, context, issues),
        (attempt) => this.terminal(attempt, context),
        (attempt) => {
          attempt.addIssue('account-registry', 'retry-sign-out');
          return this.terminal(attempt, context);
        },
      );
    });
  }

  private run(
    attempt: AccountCleanupAttempt<AccountSignOutOutcome>,
    context: SignOutRetryContext,
    issues: readonly AccountCleanupIssue[],
  ): Observable<unknown> {
    for (const issue of issues) attempt.addIssue(issue.scope, issue.recovery);
    const retryable = new Set(
      issues
        .filter(({ recovery }) => recovery === 'retry-sign-out')
        .map(({ scope }) => scope),
    );
    const operations: Observable<unknown>[] = [];
    if (retryable.has('notifications')) {
      operations.push(
        this.retryStep(
          attempt,
          context.remainingAccountIds.length === 0
            ? this.lifecycle.unregisterNotifications()
            : this.lifecycle.unregisterNotifications(context.accountId),
          'notifications',
          ACCOUNT_CLEANUP_STEP_BUDGET_MS.notificationUnregister,
        ),
      );
    }
    if (retryable.has('provider-session') && context.session?.oidc) {
      operations.push(
        this.retryStep(
          attempt,
          this.lifecycle.revokeProviderSession(context.session),
          'provider-session',
          ACCOUNT_CLEANUP_STEP_BUDGET_MS.providerLogout,
        ),
      );
    }
    if (retryable.has('matrix-session') && context.client) {
      operations.push(
        this.retryStep(
          attempt,
          defer(() => from(context.client!.logout(true))),
          'matrix-session',
          ACCOUNT_CLEANUP_STEP_BUDGET_MS.matrixLogout,
        ),
      );
    }
    if (retryable.has('drafts')) {
      operations.push(
        this.retryStep(
          attempt,
          defer(() => {
            this.lifecycle.clearDrafts();
            return of(void 0);
          }),
          'drafts',
          ACCOUNT_CLEANUP_STEP_BUDGET_MS.registryWrite,
        ),
      );
    }
    if (retryable.has('account-registry') || retryable.has('secure-storage')) {
      operations.push(this.retryAccountRegistry(attempt, context));
    }
    return operations.length === 0
      ? of(void 0)
      : from(operations).pipe(
          concatMap((operation) => operation),
          reduce(() => undefined, undefined),
        );
  }

  private retryAccountRegistry(
    attempt: AccountCleanupAttempt<AccountSignOutOutcome>,
    context: SignOutRetryContext,
  ): Observable<unknown> {
    const source =
      context.remainingAccountIds.length === 0
        ? this.storage.clear()
        : this.storage.remove(context.accountId).pipe(
            concatMap(() => {
              const active = context.remainingAccountIds[0] ?? null;
              return active ? this.storage.setActive(active) : of(void 0);
            }),
          );
    return attempt.step(source, {
      budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.registryWrite,
      scope: 'account-registry',
      recovery: 'retry-sign-out',
      fallback: undefined,
      onSettled: () => {
        attempt.resolveIssue('account-registry');
        attempt.resolveIssue('secure-storage');
      },
    });
  }

  private retryStep(
    attempt: AccountCleanupAttempt<AccountSignOutOutcome>,
    source: Observable<unknown>,
    scope: AccountCleanupScope,
    budgetMs: number,
  ): Observable<unknown> {
    return attempt.step(source, {
      budgetMs,
      scope,
      recovery: 'retry-sign-out',
      fallback: undefined,
      onSettled: () => attempt.resolveIssue(scope),
    });
  }

  private terminal(
    attempt: AccountCleanupAttempt<AccountSignOutOutcome>,
    context: SignOutRetryContext,
  ): AccountSignOutOutcome {
    const issues = attempt.settledIssues();
    const liveActive = this.matrix.activeUserId();
    const activeAccountId =
      liveActive && context.remainingAccountIds.includes(liveActive)
        ? liveActive
        : (context.remainingAccountIds[0] ?? null);
    const base = {
      accountId: context.accountId,
      activeAccountId,
      remainingAccountIds: context.remainingAccountIds,
    };
    if (issues.length === 0) {
      this.clear(context.accountId);
      return { kind: 'ready', ...base };
    }
    this.retain(context);
    return { kind: 'partial-cleanup', ...base, issues };
  }
}
