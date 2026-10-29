import { Injectable, inject } from '@angular/core';
import {
  SESSION_ENGINE,
  SessionStateService,
  type SessionEngine,
} from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
import {
  engineOk,
  unwrapEngineResult,
  type MatrixSession,
} from '@trinity/util/matrix';
import { Observable, concatMap, defer, from, of, reduce } from 'rxjs';
import {
  AccountCleanupAttempt,
  runDetachedCleanupAttempt,
} from './account-cleanup-attempt';
import { ACCOUNT_CLEANUP_STEP_BUDGET_MS } from './account-cleanup-policy';
import { ACCOUNT_LIFECYCLE_PORT } from './account-lifecycle.port';
import { accountSignOutSettlement } from './account-sign-out-outcome';
import type {
  AccountCleanupIssue,
  AccountCleanupScope,
  AccountSignOutOutcome,
} from './account-runtime.models';

export interface SignOutRetryContext {
  readonly accountId: string;
  readonly remainingAccountIds: readonly string[];
  /**
   * The client that was live when sign-out began, and its credentials, taken before the
   * account is removed so a retry can still log it out once the client is gone.
   */
  readonly live: {
    readonly generation: number;
    readonly session: MatrixSession;
  } | null;
  readonly providerExpected: boolean;
  session: MatrixSession | null;
}

/**
 * End the account's remote session once. The live client is used while it is the one sign-out
 * began with: logging out stops it, so its own requests never meet the dead token. Otherwise
 * its captured credentials are logged out, never a newer sign-in's. Without a live client, a
 * stored OAuth session is still logged out so its tokens are revoked. For OAuth this revokes
 * at the provider (no `POST /logout`); a password or SSO session ends at the homeserver.
 */
export function remoteLogout(
  context: SignOutRetryContext,
  engine: SessionEngine,
  state: SessionStateService,
): Observable<unknown> {
  return defer(() => {
    const { accountId, live } = context;
    if (live && state.status(accountId)?.generation === live.generation) {
      return engine.logoutRemote(accountId);
    }
    const credentials = live
      ? (context.session ?? live.session)
      : context.session?.oidc
        ? context.session
        : null;
    return credentials ? engine.logoutSession(credentials) : of(engineOk(null));
  }).pipe(unwrapEngineResult());
}

/** Where a failed {@link remoteLogout} is reported: the provider owns OAuth tokens. */
export function remoteLogoutScope(
  context: SignOutRetryContext,
): AccountCleanupScope {
  return context.providerExpected ? 'provider-session' : 'matrix-session';
}

/** Retains only the context required to retry settled, safe Account-removal residue. */
@Injectable({ providedIn: 'root' })
export class AccountSignOutRetryWorkflow {
  private readonly engine = inject(SESSION_ENGINE);
  private readonly state = inject(SessionStateService);
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
      return runDetachedCleanupAttempt<AccountSignOutOutcome>(
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
      operations.push(...this.retryNotifications(attempt, context));
    }
    const logoutScope = remoteLogoutScope(context);
    // Without a client or a stored OAuth session there is nothing to log out with, and
    // resolving the residue anyway would claim a revocation that never happened.
    if (retryable.has(logoutScope) && (context.live || context.session?.oidc)) {
      operations.push(
        this.retryStep(
          attempt,
          remoteLogout(context, this.engine, this.state),
          logoutScope,
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

  /**
   * The push handoff removal and the pusher teardown share the `notifications` scope but
   * run as separate steps, so a refused removal never skips the teardown. The residue is
   * resolved only once both have succeeded.
   */
  private retryNotifications(
    attempt: AccountCleanupAttempt<AccountSignOutOutcome>,
    context: SignOutRetryContext,
  ): Observable<unknown>[] {
    let succeeded = 0;
    const step = (source: Observable<unknown>): Observable<unknown> =>
      attempt.step(source, {
        budgetMs: ACCOUNT_CLEANUP_STEP_BUDGET_MS.notificationUnregister,
        scope: 'notifications',
        recovery: 'retry-sign-out',
        onSettled: () => {
          succeeded += 1;
          if (succeeded === 2) attempt.resolveIssue('notifications');
        },
      });
    return [
      step(this.lifecycle.forgetPushHandoff(context.accountId)),
      step(
        context.remainingAccountIds.length === 0
          ? this.lifecycle.unregisterNotifications()
          : this.lifecycle.unregisterNotifications(context.accountId),
      ),
    ];
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
      onSettled: () => attempt.resolveIssue(scope),
    });
  }

  private terminal(
    attempt: AccountCleanupAttempt<AccountSignOutOutcome>,
    context: SignOutRetryContext,
  ): AccountSignOutOutcome {
    const issues = attempt.settledIssues();
    const outcome = accountSignOutSettlement(
      this.state.activeAccountId(),
      context,
      issues,
    );
    if (issues.length === 0) {
      this.clear(context.accountId);
      return outcome;
    }
    this.retain(context);
    return outcome;
  }
}
