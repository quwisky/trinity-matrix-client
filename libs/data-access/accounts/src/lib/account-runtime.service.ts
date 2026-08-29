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
  shareReplay,
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
  type AdapterAccountEstablishmentOutcome,
  type AdapterAccountRestoreOutcome,
  type SavedAccountsSnapshot,
} from './account-runtime.adapter';
import { AccountSwitchWorkflow } from './account-switch.workflow';
import { AccountLifecycleWorkflow } from './account-lifecycle.workflow';
import {
  AuthenticatedAccountGrant,
  authenticatedAccountGrantPayload,
  sameAuthenticatedAccountGrant,
} from './authenticated-account-grant';
import type {
  AccountEstablishmentIntent,
  AccountEstablishmentOutcome,
  AccountRestoreMetrics,
  AccountRestoreOutcome,
  AccountRestoreRole,
  AccountRestoreResult,
  AccountRuntimeState,
  AccountSignOutOutcome,
  AccountSwitchOutcome,
  InstallationResetOutcome,
} from './account-runtime.models';

interface InFlightAccountEstablishment {
  readonly grant: AuthenticatedAccountGrant;
  readonly intent: AccountEstablishmentIntent;
  readonly outcome: Observable<AccountEstablishmentOutcome>;
}

@Injectable({ providedIn: 'root' })
export class AccountRuntimeService {
  private readonly adapter = inject(ACCOUNT_RUNTIME_ADAPTER);
  private readonly policy = inject(ACCOUNT_RESTORE_POLICY);
  private readonly switchWorkflow = inject(AccountSwitchWorkflow);
  private readonly lifecycleWorkflow = inject(AccountLifecycleWorkflow);
  private readonly runtimeState = signal<AccountRuntimeState>({
    phase: 'idle',
  });
  private establishment: InFlightAccountEstablishment | null = null;

  readonly state = this.runtimeState.asReadonly();
  readonly activeAccountId = this.adapter.activeAccountId;
  readonly hasActiveAccount = computed(() => this.activeAccountId() !== null);

  restoreSavedAccounts(): Observable<AccountRestoreResult> {
    return defer(() => {
      const startedAt = performance.now();
      if (this.establishment) {
        return of(this.transitionRestoreResult(performance.now() - startedAt));
      }
      if (this.switchWorkflow.inProgress) {
        return of(
          this.transitionRestoreResult(
            performance.now() - startedAt,
            'switching-account',
          ),
        );
      }
      if (this.lifecycleWorkflow.operation) {
        return of(
          this.transitionRestoreResult(
            performance.now() - startedAt,
            this.lifecycleWorkflow.operation,
          ),
        );
      }
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

  establishAuthenticatedAccount(
    grant: AuthenticatedAccountGrant,
    intent: AccountEstablishmentIntent,
  ): Observable<AccountEstablishmentOutcome> {
    return defer(() => {
      const session = authenticatedAccountGrantPayload(grant);
      if (this.runtimeState().phase === 'restoring') {
        return of(this.transitionOutcome(session.userId, intent));
      }
      if (this.switchWorkflow.inProgress) {
        return of(this.transitionOutcome(session.userId, intent));
      }
      if (this.lifecycleWorkflow.operation) {
        return of(this.transitionOutcome(session.userId, intent));
      }
      const inFlight = this.establishment;
      if (inFlight) {
        return sameAuthenticatedAccountGrant(inFlight.grant, grant) &&
          this.sameIntent(inFlight.intent, intent)
          ? inFlight.outcome
          : of(this.transitionOutcome(session.userId, intent));
      }

      let termination: 'pending' | 'settled' | 'failed' = 'pending';
      this.runtimeState.set({
        phase: 'establishing',
        accountId: session.userId,
        placement: intent.placement,
      });
      const outcome = this.adapter.establishAccount(grant, intent).pipe(
        take(1),
        throwIfEmpty(
          () => new Error('Account Runtime adapter emitted no outcome.'),
        ),
        map((adapterOutcome) =>
          this.toEstablishmentOutcome(session.userId, intent, adapterOutcome),
        ),
        tap((result) => {
          termination = 'settled';
          this.runtimeState.set({
            phase: 'establishment-settled',
            outcome: result,
          });
        }),
        catchError((error: unknown) => {
          termination = 'failed';
          return throwError(() => error);
        }),
        finalize(() => {
          if (this.establishment?.outcome === outcome) {
            this.establishment = null;
          }
          if (termination !== 'settled') {
            this.runtimeState.set({
              phase:
                termination === 'failed'
                  ? 'establishment-failed'
                  : 'establishment-cancelled',
              accountId: session.userId,
              placement: intent.placement,
            });
          }
        }),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
      this.establishment = { grant, intent, outcome };
      return outcome;
    });
  }

  switchActiveAccount(
    accountId: string,
    prepare: () => Observable<void> = () => of(void 0),
  ): Observable<AccountSwitchOutcome> {
    return defer(() =>
      this.switchWorkflow.run(
        accountId,
        this.activeAccountId,
        this.blockingSwitchOperation(),
        prepare,
        (state) => this.runtimeState.set(state),
      ),
    );
  }

  signOutAccount(accountId: string): Observable<AccountSignOutOutcome> {
    return defer(() =>
      this.lifecycleWorkflow.signOut(
        accountId,
        this.blockingLifecycleOperation(),
      ),
    );
  }

  resetInstallation(): Observable<InstallationResetOutcome> {
    return defer(() =>
      this.lifecycleWorkflow.reset(this.blockingLifecycleOperation()),
    );
  }

  private blockingSwitchOperation():
    | 'restoring-accounts'
    | 'establishing-account'
    | 'signing-out-account'
    | 'resetting-installation'
    | null {
    const phase = this.runtimeState().phase;
    if (phase === 'restoring') return 'restoring-accounts';
    if (phase === 'establishing') return 'establishing-account';
    return this.lifecycleWorkflow.operation;
  }

  private blockingLifecycleOperation():
    'restoring-accounts' | 'establishing-account' | 'switching-account' | null {
    const phase = this.runtimeState().phase;
    if (phase === 'restoring') return 'restoring-accounts';
    if (phase === 'establishing') return 'establishing-account';
    if (this.switchWorkflow.inProgress) return 'switching-account';
    return null;
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

  private toEstablishmentOutcome(
    accountId: string,
    intent: AccountEstablishmentIntent,
    outcome: AdapterAccountEstablishmentOutcome,
  ): AccountEstablishmentOutcome {
    return outcome.kind === 'ready'
      ? { kind: 'ready', accountId, placement: intent.placement }
      : {
          kind: 'failed',
          accountId,
          placement: intent.placement,
          failure: outcome.failure,
        };
  }

  private transitionOutcome(
    accountId: string,
    intent: AccountEstablishmentIntent,
  ): AccountEstablishmentOutcome {
    return {
      kind: 'transition-in-progress',
      accountId,
      placement: intent.placement,
    };
  }

  private sameIntent(
    left: AccountEstablishmentIntent,
    right: AccountEstablishmentIntent,
  ): boolean {
    return (
      left.placement === right.placement &&
      left.liveAccounts === right.liveAccounts &&
      left.accountRecord === right.accountRecord
    );
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

  private transitionRestoreResult(
    durationMs: number,
    operation:
      | 'establishing-account'
      | 'switching-account'
      | 'signing-out-account'
      | 'resetting-installation' = 'establishing-account',
  ): AccountRestoreResult {
    return {
      kind: 'transition-in-progress',
      operation,
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
