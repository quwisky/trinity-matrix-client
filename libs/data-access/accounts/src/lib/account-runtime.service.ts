import { Injectable, computed, inject, signal } from '@angular/core';
import {
  Observable,
  TimeoutError,
  catchError,
  defer,
  finalize,
  from,
  map,
  mergeMap,
  of,
  switchMap,
  take,
  tap,
  throwError,
  throwIfEmpty,
  timeout,
  toArray,
} from 'rxjs';
import {
  ACCOUNT_RESTORE_POLICY,
  ACCOUNT_RUNTIME_ADAPTER,
  type AdapterAccountRestoreOutcome,
  type SavedAccountsSnapshot,
} from './account-runtime.adapter';
import type {
  AccountRestoreMetrics,
  AccountRestoreOutcome,
  AccountRestoreRole,
  AccountRestoreResult,
  AccountRuntimeState,
} from './account-runtime.models';

@Injectable({ providedIn: 'root' })
export class AccountRuntimeService {
  private readonly adapter = inject(ACCOUNT_RUNTIME_ADAPTER);
  private readonly policy = inject(ACCOUNT_RESTORE_POLICY);
  private readonly runtimeState = signal<AccountRuntimeState>({
    phase: 'idle',
  });

  readonly state = this.runtimeState.asReadonly();
  readonly activeAccountId = this.adapter.activeAccountId;
  readonly hasActiveAccount = computed(() => this.activeAccountId() !== null);

  restoreSavedAccounts(): Observable<AccountRestoreResult> {
    return defer(() => {
      const startedAt = performance.now();
      let termination: 'pending' | 'settled' | 'failed' = 'pending';
      let activeAccountId: string | null = null;
      let totalAccounts = 0;
      const outcomes = new Map<string, AccountRestoreOutcome>();

      this.runtimeState.set({
        phase: 'restoring',
        activeAccountId,
        totalAccounts,
        outcomes: [],
      });

      return this.adapter.sweepOrphanedStores().pipe(
        catchError(() => of(void 0)),
        switchMap(() => this.adapter.readSavedAccounts()),
        switchMap((snapshot) => {
          if (snapshot.kind === 'corrupt-local-state') {
            return of(
              this.emptyResult(
                'local-state-unavailable',
                performance.now() - startedAt,
              ),
            );
          }
          activeAccountId = snapshot.activeAccountId;
          totalAccounts = snapshot.accountIds.length;
          this.publishProgress(activeAccountId, totalAccounts, outcomes);
          return this.restoreSnapshot(snapshot, startedAt, outcomes);
        }),
        tap((result) => {
          termination = 'settled';
          this.runtimeState.set({ phase: 'settled', result });
        }),
        catchError((error: unknown) => {
          termination = 'failed';
          return throwError(() => error);
        }),
        finalize(() => {
          if (termination !== 'settled') {
            this.runtimeState.set({
              phase: termination === 'failed' ? 'failed' : 'cancelled',
              activeAccountId,
              totalAccounts,
              outcomes: [...outcomes.values()],
            });
          }
        }),
      );
    });
  }

  private restoreSnapshot(
    snapshot: Extract<SavedAccountsSnapshot, { kind: 'available' }>,
    startedAt: number,
    outcomes: Map<string, AccountRestoreOutcome>,
  ): Observable<AccountRestoreResult> {
    if (snapshot.accountIds.length === 0) {
      return of(this.emptyResult('no-accounts', performance.now() - startedAt));
    }
    if (
      !snapshot.activeAccountId ||
      !snapshot.accountIds.includes(snapshot.activeAccountId) ||
      new Set(snapshot.accountIds).size !== snapshot.accountIds.length
    ) {
      return of(
        this.emptyResult(
          'local-state-unavailable',
          performance.now() - startedAt,
        ),
      );
    }

    const activeAccountId = snapshot.activeAccountId;
    const orderedAccountIds = [
      activeAccountId,
      ...snapshot.accountIds.filter(
        (accountId) => accountId !== activeAccountId,
      ),
    ];

    return from(orderedAccountIds).pipe(
      mergeMap(
        (accountId) =>
          this.restoreOne(
            accountId,
            accountId === activeAccountId ? 'active' : 'inactive',
          ).pipe(
            tap((outcome) => {
              outcomes.set(accountId, outcome);
              this.publishProgress(
                activeAccountId,
                orderedAccountIds.length,
                outcomes,
              );
            }),
          ),
        this.policy.concurrency,
      ),
      toArray(),
      map(() => {
        const orderedOutcomes = orderedAccountIds.map((accountId) =>
          outcomes.get(accountId)!,
        );
        return this.resultFor(
          activeAccountId,
          orderedOutcomes,
          performance.now() - startedAt,
        );
      }),
    );
  }

  private restoreOne(
    accountId: string,
    role: AccountRestoreRole,
  ): Observable<AccountRestoreOutcome> {
    const startedAt = performance.now();
    return this.adapter.restoreAccount(accountId, role).pipe(
      take(1),
      throwIfEmpty(
        () => new Error('Account Runtime adapter emitted no outcome.'),
      ),
      map((outcome) =>
        this.toPublicOutcome(
          accountId,
          role,
          performance.now() - startedAt,
          outcome,
        ),
      ),
      timeout({ first: this.policy.timeoutMs }),
      catchError((error: unknown) =>
        error instanceof TimeoutError
          ? of({
              kind: 'timed-out' as const,
              accountId,
              role,
              durationMs: performance.now() - startedAt,
            })
          : throwError(() => error),
      ),
    );
  }

  private toPublicOutcome(
    accountId: string,
    role: AccountRestoreRole,
    durationMs: number,
    outcome: AdapterAccountRestoreOutcome,
  ): AccountRestoreOutcome {
    if (outcome.kind === 'failed') {
      return { ...outcome, accountId, role, durationMs };
    }
    return { kind: outcome.kind, accountId, role, durationMs };
  }

  private resultFor(
    activeAccountId: string,
    accounts: readonly AccountRestoreOutcome[],
    durationMs: number,
  ): AccountRestoreResult {
    const metrics = this.metrics(accounts, durationMs);
    const active = accounts.find((account) => account.role === 'active')!;
    if (active.kind !== 'ready') {
      return {
        kind: 'active-account-unavailable',
        activeAccountId,
        accounts,
        metrics,
      };
    }
    if (
      accounts.some(
        (account) => account.role === 'inactive' && account.kind !== 'ready',
      )
    ) {
      return {
        kind: 'restored-with-inactive-failures',
        activeAccountId,
        accounts,
        metrics,
      };
    }
    return { kind: 'restored', activeAccountId, accounts, metrics };
  }

  private metrics(
    accounts: readonly AccountRestoreOutcome[],
    durationMs: number,
  ): AccountRestoreMetrics {
    return {
      durationMs,
      activeTerminalMs:
        accounts.find((account) => account.role === 'active')?.durationMs ??
        null,
      terminalAccounts: accounts.length,
      totalAccounts: accounts.length,
    };
  }

  private emptyResult(
    kind: 'no-accounts' | 'local-state-unavailable',
    durationMs: number,
  ): AccountRestoreResult {
    return {
      kind,
      accounts: [],
      metrics: {
        durationMs,
        activeTerminalMs: null,
        terminalAccounts: 0,
        totalAccounts: 0,
      },
    };
  }

  private publishProgress(
    activeAccountId: string | null,
    totalAccounts: number,
    outcomes: ReadonlyMap<string, AccountRestoreOutcome>,
  ): void {
    this.runtimeState.set({
      phase: 'restoring',
      activeAccountId,
      totalAccounts,
      outcomes: [...outcomes.values()],
    });
  }
}
