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
  switchMap,
  take,
  tap,
  timeout,
} from 'rxjs';
import { ACCOUNT_LIFECYCLE_PORT } from './account-lifecycle.port';
import type {
  AccountCleanupIssue,
  AccountSignOutOutcome,
  InstallationResetOutcome,
} from './account-runtime.models';

const SIGN_OUT_BUDGET_MS = 3_000;

/** Matrix-backed cleanup workflows kept separate from restore and establishment. */
@Injectable({ providedIn: 'root' })
export class AccountLifecycleAdapter {
  private readonly matrix = inject(MatrixClientService);
  private readonly storage = inject(SessionStorageService);
  private readonly wipe = inject(LocalDataWipeService);
  private readonly lifecycle = inject(ACCOUNT_LIFECYCLE_PORT);

  signOutAccount(accountId: string): Observable<AccountSignOutOutcome> {
    return defer(() =>
      this.storage.list().pipe(
        catchError(() =>
          of({ kind: 'registry-failed' as const, accounts: [] }),
        ),
        map((accounts) =>
          Array.isArray(accounts)
            ? { kind: 'available' as const, accounts }
            : accounts,
        ),
        switchMap((registry) => {
          if (registry.kind === 'registry-failed') {
            return of({
              kind: 'failed' as const,
              accountId,
              failure: 'local-state-unavailable' as const,
              recovery: 'retry-sign-out' as const,
            });
          }
          if (
            !registry.accounts.some((account) => account.userId === accountId)
          ) {
            return of({
              kind: 'failed' as const,
              accountId,
              failure: 'account-unavailable' as const,
              recovery: 'retry-sign-out' as const,
            });
          }
          return this.runSignOut(accountId, registry.accounts);
        }),
      ),
    );
  }

  resetInstallation(): Observable<InstallationResetOutcome> {
    return defer(() => {
      const issues: AccountCleanupIssue[] = [];
      return this.storage.list().pipe(
        catchError(() => {
          this.addIssue(issues, 'account-registry', 'retry-installation-reset');
          return of([]);
        }),
        switchMap((records) => this.readSessions(records, issues)),
        switchMap(({ records, sessions }) =>
          this.courtesySignOut(sessions, issues).pipe(map(() => records)),
        ),
        concatMap((records) =>
          this.capture(
            this.matrix.stop(),
            issues,
            'matrix-session',
            'restart-application',
          ).pipe(map(() => records)),
        ),
        concatMap((records) =>
          defer(() => from(this.wipe.wipeIndexedDb(records))).pipe(
            tap((report) => {
              if (
                report.blocked.length > 0 ||
                report.failed.length > 0 ||
                !report.enumerated
              ) {
                this.addIssue(issues, 'indexed-db', 'restart-application');
              }
            }),
            catchError(() => {
              this.addIssue(issues, 'indexed-db', 'restart-application');
              return of(undefined);
            }),
          ),
        ),
        concatMap(() =>
          this.capture(
            this.storage.clearAll(),
            issues,
            'secure-storage',
            'retry-installation-reset',
          ),
        ),
        concatMap(() =>
          defer(() => from(this.wipe.wipeKeyValueStores())).pipe(
            tap((report) => {
              if (!report.secureStorage) {
                this.addIssue(
                  issues,
                  'secure-storage',
                  'retry-installation-reset',
                );
              }
              if (!report.preferences || !report.webStorage) {
                this.addIssue(
                  issues,
                  'preferences',
                  'retry-installation-reset',
                );
              }
            }),
            catchError(() => {
              this.addIssue(
                issues,
                'secure-storage',
                'retry-installation-reset',
              );
              this.addIssue(issues, 'preferences', 'retry-installation-reset');
              return of(undefined);
            }),
          ),
        ),
        concatMap(() =>
          defer(() => from(this.wipe.wipeServiceWorker())).pipe(
            tap((report) => {
              if (!report.cacheStorage || !report.registrations) {
                this.addIssue(issues, 'service-worker', 'restart-application');
              }
            }),
            catchError(() => {
              this.addIssue(issues, 'service-worker', 'restart-application');
              return of(undefined);
            }),
          ),
        ),
        map(() =>
          issues.length === 0
            ? ({ kind: 'ready' } as const)
            : ({ kind: 'partial-cleanup', issues } as const),
        ),
      );
    });
  }

  private readSessions(
    records: readonly AccountRecord[],
    issues: AccountCleanupIssue[],
  ): Observable<{
    records: readonly AccountRecord[];
    sessions: readonly (MatrixSession | null)[];
  }> {
    if (records.length === 0) return of({ records, sessions: [] });
    return forkJoin(
      records.map((record) =>
        this.storage.load(record.userId).pipe(
          catchError(() => {
            this.addIssue(issues, 'secure-storage', 'retry-installation-reset');
            return of(null);
          }),
        ),
      ),
    ).pipe(map((sessions) => ({ records, sessions })));
  }

  private courtesySignOut(
    sessions: readonly (MatrixSession | null)[],
    issues: AccountCleanupIssue[],
  ): Observable<unknown> {
    const attempts = [
      this.captureWithinBudget(
        this.matrix.signOutAll(),
        issues,
        'matrix-session',
        'restart-application',
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
          this.captureWithinBudget(
            this.lifecycle.revokeProviderSession(session),
            issues,
            'provider-session',
            'retry-installation-reset',
          ),
        ),
    ];
    return forkJoin(attempts);
  }

  private captureWithinBudget(
    source: Observable<unknown>,
    issues: AccountCleanupIssue[],
    scope: AccountCleanupIssue['scope'],
    recovery: AccountCleanupIssue['recovery'],
  ): Observable<void> {
    return this.capture(
      source.pipe(timeout({ first: SIGN_OUT_BUDGET_MS })),
      issues,
      scope,
      recovery,
    );
  }

  private runSignOut(
    accountId: string,
    accounts: readonly { readonly userId: string }[],
  ): Observable<AccountSignOutOutcome> {
    const issues: AccountCleanupIssue[] = [];
    const remainingAccountIds = accounts
      .map((account) => account.userId)
      .filter((id) => id !== accountId);
    const client = this.matrix.clientFor(accountId);
    const serverLogout$ = client
      ? defer(() => from(client.logout(true)))
      : of(void 0);

    return this.storage.load(accountId).pipe(
      catchError(() => {
        this.addIssue(issues, 'secure-storage', 'retry-sign-out');
        return of(null);
      }),
      switchMap((session) =>
        from([
          this.capture(
            remainingAccountIds.length === 0
              ? this.lifecycle.unregisterNotifications()
              : this.lifecycle.unregisterNotifications(accountId),
            issues,
            'notifications',
            'retry-sign-out',
          ),
          ...(session?.oidc
            ? [
                this.capture(
                  this.lifecycle.revokeProviderSession(session),
                  issues,
                  'provider-session',
                  'retry-sign-out',
                ),
              ]
            : []),
          this.capture(
            serverLogout$,
            issues,
            'matrix-session',
            'retry-sign-out',
          ),
        ]).pipe(concatMap((step) => step)),
      ),
      reduce(() => undefined, undefined),
      concatMap(() =>
        remainingAccountIds.length === 0
          ? this.clearLastAccount(accountId, issues)
          : this.removeOneAccount(accountId, remainingAccountIds, issues),
      ),
      map(() => {
        const liveActive = this.matrix.activeUserId();
        const activeAccountId =
          liveActive && remainingAccountIds.includes(liveActive)
            ? liveActive
            : (remainingAccountIds[0] ?? null);
        return issues.length === 0
          ? {
              kind: 'ready' as const,
              accountId,
              activeAccountId,
              remainingAccountIds,
            }
          : {
              kind: 'partial-cleanup' as const,
              accountId,
              activeAccountId,
              remainingAccountIds,
              issues,
            };
      }),
    );
  }

  private clearLastAccount(
    accountId: string,
    issues: AccountCleanupIssue[],
  ): Observable<void> {
    return this.capture(
      this.matrix.remove(accountId),
      issues,
      'crypto-and-cache',
      'restart-application',
    ).pipe(
      tap(() => {
        this.lifecycle.releaseSharedCaches();
        this.lifecycle.clearDrafts();
      }),
      concatMap(() =>
        this.capture(
          this.storage.clear(),
          issues,
          'account-registry',
          'retry-sign-out',
        ),
      ),
    );
  }

  private removeOneAccount(
    accountId: string,
    remainingAccountIds: readonly string[],
    issues: AccountCleanupIssue[],
  ): Observable<void> {
    return this.capture(
      this.matrix.remove(accountId),
      issues,
      'crypto-and-cache',
      'restart-application',
    ).pipe(
      tap(() => this.lifecycle.clearDrafts()),
      concatMap(() =>
        this.capture(
          this.storage.remove(accountId),
          issues,
          'account-registry',
          'retry-sign-out',
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
              this.storage.setActive(active),
              issues,
              'account-registry',
              'retry-sign-out',
            )
          : of(void 0);
      }),
    );
  }

  private capture(
    source: Observable<unknown>,
    issues: AccountCleanupIssue[],
    scope: AccountCleanupIssue['scope'],
    recovery: AccountCleanupIssue['recovery'],
  ): Observable<void> {
    return source.pipe(
      take(1),
      map(() => void 0),
      defaultIfEmpty(void 0),
      catchError(() => {
        this.addIssue(issues, scope, recovery);
        return of(void 0);
      }),
    );
  }

  private addIssue(
    issues: AccountCleanupIssue[],
    scope: AccountCleanupIssue['scope'],
    recovery: AccountCleanupIssue['recovery'],
  ): void {
    if (!issues.some((issue) => issue.scope === scope)) {
      issues.push({ scope, recovery });
    }
  }
}
