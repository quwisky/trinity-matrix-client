import { Injectable, computed, inject, signal } from '@angular/core';
import {
  Observable,
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
  toArray,
} from 'rxjs';
import {
  ACCOUNT_RESTORE_POLICY,
  ACCOUNT_RUNTIME_ADAPTER,
  type AdapterAccountEstablishmentOutcome,
  type SavedAccountsSnapshot,
} from './account-runtime.adapter';
import { AccountSwitchWorkflow } from './account-switch.workflow';
import { AccountLifecycleWorkflow } from './account-lifecycle.workflow';
import { InactiveAccountRestoreWorkflow } from './inactive-account-restore.workflow';
import {
  accountRestoreResultFor,
  accountRestoreTransitionResult,
  emptyAccountRestoreResult,
} from './account-restore-results';
import { restoreAccountWithinPolicy } from './account-restore-attempt';
import {
  AuthenticatedAccountGrant,
  authenticatedAccountGrantPayload,
  sameAuthenticatedAccountGrant,
} from './authenticated-account-grant';
import type {
  AccountEstablishmentIntent,
  AccountEstablishmentOutcome,
  AccountRestoreOutcome,
  AccountRestoreRole,
  AccountRestoreResult,
  AccountRuntimeOperation,
  AccountRuntimeState,
  AccountSignOutOutcome,
  AccountSwitchCoordination,
  AccountSwitchOutcome,
  InstallationResetOutcome,
  InactiveAccountRestoreRetryOutcome,
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
  private readonly inactiveRestore = inject(InactiveAccountRestoreWorkflow);
  private readonly runtimeState = signal<AccountRuntimeState>({
    phase: 'idle',
  });
  private establishment: InFlightAccountEstablishment | null = null;

  readonly state = this.runtimeState.asReadonly();
  /** Value-free destructive cleanup progress retained independently of UI observers. */
  readonly lifecycle = this.lifecycleWorkflow.state;
  readonly activeAccountId = this.adapter.activeAccountId;
  readonly hasActiveAccount = computed(() => this.activeAccountId() !== null);

  restoreSavedAccounts(): Observable<AccountRestoreResult> {
    return defer(() => {
      const startedAt = performance.now();
      const operation = this.currentOperation();
      if (operation) {
        return of(
          accountRestoreTransitionResult(
            performance.now() - startedAt,
            operation,
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
              emptyAccountRestoreResult(
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

  retryInactiveAccount(
    accountId: string,
  ): Observable<InactiveAccountRestoreRetryOutcome> {
    return defer(() => {
      const conflict = this.blockingInactiveRestoreOperation();
      if (conflict) {
        return of({
          kind: 'transition-in-progress' as const,
          operation: conflict,
        });
      }
      const state = this.runtimeState();
      if (state.phase !== 'settled') {
        return of({ kind: 'unavailable' } as const);
      }
      const result = state.result;
      if (
        result.kind !== 'restored-with-inactive-failures' &&
        result.kind !== 'restored'
      ) {
        return of({ kind: 'unavailable' } as const);
      }
      const previous = result.accounts.find(
        (account) => account.accountId === accountId,
      );
      return this.inactiveRestore.run(previous, (outcome) =>
        this.publishInactiveRetry(outcome),
      );
    });
  }

  establishAuthenticatedAccount(
    grant: AuthenticatedAccountGrant,
    intent: AccountEstablishmentIntent,
  ): Observable<AccountEstablishmentOutcome> {
    return defer(() => {
      const session = authenticatedAccountGrantPayload(grant);
      const operation = this.currentOperation();
      if (operation && operation !== 'establishing-account') {
        return of(this.transitionOutcome(session.userId, intent));
      }
      const inFlight = this.establishment;
      if (inFlight) {
        return sameAuthenticatedAccountGrant(inFlight.grant, grant) &&
          this.sameIntent(inFlight.intent, intent)
          ? inFlight.outcome
          : of(this.transitionOutcome(session.userId, intent));
      }
      if (operation) {
        return of(this.transitionOutcome(session.userId, intent));
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
    coordination: AccountSwitchCoordination = {
      prepare: () => of(void 0),
    },
  ): Observable<AccountSwitchOutcome> {
    return defer(() =>
      this.switchWorkflow.run(
        accountId,
        this.activeAccountId,
        this.blockingSwitchOperation(),
        coordination.prepare,
        coordination.onCommitStarted ?? (() => undefined),
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

  private blockingSwitchOperation(): Exclude<
    AccountRuntimeOperation,
    'switching-account'
  > | null {
    const operation = this.currentOperation();
    return operation === 'switching-account' ? null : operation;
  }

  private blockingLifecycleOperation(): Exclude<
    AccountRuntimeOperation,
    'signing-out-account' | 'resetting-installation'
  > | null {
    const operation = this.currentOperation();
    return operation === 'signing-out-account' ||
      operation === 'resetting-installation'
      ? null
      : operation;
  }

  private blockingInactiveRestoreOperation(): AccountRuntimeOperation | null {
    return this.currentOperation(false);
  }

  private currentOperation(
    includeInactiveRestore = true,
  ): AccountRuntimeOperation | null {
    if (includeInactiveRestore && this.inactiveRestore.inProgress)
      return 'restoring-accounts';
    const phase = this.runtimeState().phase;
    if (phase === 'restoring') return 'restoring-accounts';
    if (phase === 'establishing' || this.establishment)
      return 'establishing-account';
    if (this.switchWorkflow.inProgress) return 'switching-account';
    return this.lifecycleWorkflow.operation;
  }

  private publishInactiveRetry(outcome: AccountRestoreOutcome): void {
    const state = this.runtimeState();
    if (state.phase !== 'settled') return;
    const result = state.result;
    if (
      result.kind !== 'restored-with-inactive-failures' &&
      result.kind !== 'restored'
    ) {
      return;
    }
    const accounts = result.accounts.map((account) =>
      account.accountId === outcome.accountId ? outcome : account,
    );
    this.runtimeState.set({
      phase: 'settled',
      result: accountRestoreResultFor(
        result.activeAccountId,
        accounts,
        result.metrics.durationMs + outcome.durationMs,
      ),
    });
  }

  private restoreSnapshot(
    snapshot: Extract<SavedAccountsSnapshot, { kind: 'available' }>,
    startedAt: number,
    outcomes: Map<string, AccountRestoreOutcome>,
  ): Observable<AccountRestoreResult> {
    if (snapshot.accountIds.length === 0) {
      return of(
        emptyAccountRestoreResult('no-accounts', performance.now() - startedAt),
      );
    }
    if (
      !snapshot.activeAccountId ||
      !snapshot.accountIds.includes(snapshot.activeAccountId) ||
      new Set(snapshot.accountIds).size !== snapshot.accountIds.length
    ) {
      return of(
        emptyAccountRestoreResult(
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
        return accountRestoreResultFor(
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
    return restoreAccountWithinPolicy(
      this.adapter,
      this.policy,
      accountId,
      role,
    );
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
