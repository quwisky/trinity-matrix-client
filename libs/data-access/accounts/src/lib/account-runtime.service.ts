import {
  DestroyRef,
  ErrorHandler,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  Observable,
  Subject,
  catchError,
  concat,
  defer,
  finalize,
  from,
  ignoreElements,
  map,
  mergeMap,
  of,
  shareReplay,
  switchMap,
  take,
  tap,
  throwError,
  throwIfEmpty,
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
  AccountLifecycleOperation,
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
  NewDeviceEstablishment,
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
  private readonly destroyRef = inject(DestroyRef);
  private readonly errors = inject(ErrorHandler);
  private readonly lateInactiveOutcomes = new Subject<AccountRestoreOutcome>();
  private establishment: InFlightAccountEstablishment | null = null;
  private restoredOnce = false;
  private backgroundRestoring = false;

  readonly state = this.runtimeState.asReadonly();
  /** Value-free destructive cleanup progress retained independently of UI observers. */
  readonly lifecycle = this.lifecycleWorkflow.state;
  /**
   * Whether a sign-out, an Account removal or an installation reset is under way in this tab.
   * Work that must not cut into one, a session handover, waits for it to clear.
   */
  readonly lifecycleBusy = this.lifecycleWorkflow.busy;
  readonly activeAccountId = this.adapter.activeAccountId;
  /**
   * Each sign-in that created a new device for an Account, published as soon as its record
   * is saved, so before its establishment outcome reaches the caller, and even when that
   * establishment then fails or is cancelled. Hot; never replays.
   */
  readonly newDevices: Observable<NewDeviceEstablishment> =
    this.adapter.newDevices;
  readonly hasActiveAccount = computed(() => this.activeAccountId() !== null);
  /** Each inactive Account a start restored after it settled. Hot; never replays. */
  readonly inactiveRestoreOutcomes: Observable<AccountRestoreOutcome> =
    this.lateInactiveOutcomes.asObservable();

  restoreSavedAccounts(): Observable<AccountRestoreResult> {
    return defer(() => {
      const operation = this.currentOperation();
      if (operation) {
        return of(accountRestoreTransitionResult(operation));
      }
      // Only a process's first restore: a later one can run after an offline sign-out, whose
      // kept record still awaits its retry. What it skips waits for the next start.
      const sweepsNativeTokens = !this.restoredOnce;
      this.restoredOnce = true;
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
            return of({
              result: emptyAccountRestoreResult('local-state-unavailable'),
              inactiveAccountIds: [],
            });
          }
          activeAccountId = snapshot.activeAccountId;
          totalAccounts = snapshot.accountIds.length;
          this.publishProgress(activeAccountId, totalAccounts, outcomes);
          return this.restoreActive(snapshot, outcomes);
        }),
        tap(({ result, inactiveAccountIds }) => {
          termination = 'settled';
          this.runtimeState.set({ phase: 'settled', result });
          this.restoreInBackground(
            inactiveAccountIds,
            sweepsNativeTokens && result.kind !== 'local-state-unavailable',
          );
        }),
        map(({ result }) => result),
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
        this.publishInactiveOutcome(outcome),
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

  /** Remove an account its homeserver deleted, serialized with the other lifecycle commands. */
  removeDeletedAccount(accountId: string): Observable<AccountSignOutOutcome> {
    return defer(() =>
      this.lifecycleWorkflow.removeDeleted(
        accountId,
        this.blockingLifecycleOperation(),
      ),
    );
  }

  /** Whether inactive Accounts are still restoring after the start, or being retried. */
  restoringInBackground(): boolean {
    return this.backgroundRestoring || this.inactiveRestore.inProgress;
  }

  /** The operation that would make an account deletion wait, or null when it may start. */
  deletionBlocker(): AccountRuntimeOperation | null {
    return this.currentOperation();
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
    AccountLifecycleOperation
  > | null {
    const operation = this.currentOperation();
    return operation === 'signing-out-account' ||
      operation === 'deleting-account' ||
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
    if (includeInactiveRestore && this.restoringInBackground())
      return 'restoring-accounts';
    const phase = this.runtimeState().phase;
    if (phase === 'restoring') return 'restoring-accounts';
    if (phase === 'establishing' || this.establishment)
      return 'establishing-account';
    if (this.switchWorkflow.inProgress) return 'switching-account';
    return this.lifecycleWorkflow.operation;
  }

  private publishInactiveOutcome(outcome: AccountRestoreOutcome): void {
    const state = this.runtimeState();
    if (state.phase !== 'settled') return;
    const result = state.result;
    if (
      result.kind !== 'restored-with-inactive-failures' &&
      result.kind !== 'restored' &&
      result.kind !== 'active-account-unavailable'
    ) {
      return;
    }
    const known = result.accounts.some(
      (account) => account.accountId === outcome.accountId,
    );
    const accounts = known
      ? result.accounts.map((account) =>
          account.accountId === outcome.accountId ? outcome : account,
        )
      : [...result.accounts, outcome];
    this.runtimeState.set({
      phase: 'settled',
      result: accountRestoreResultFor(result.activeAccountId, accounts),
    });
  }

  private restoreActive(
    snapshot: Extract<SavedAccountsSnapshot, { kind: 'available' }>,
    outcomes: Map<string, AccountRestoreOutcome>,
  ): Observable<{
    readonly result: AccountRestoreResult;
    readonly inactiveAccountIds: readonly string[];
  }> {
    if (snapshot.accountIds.length === 0) {
      return of({
        result: emptyAccountRestoreResult('no-accounts'),
        inactiveAccountIds: [],
      });
    }
    const activeAccountId = snapshot.activeAccountId;
    if (
      !activeAccountId ||
      !snapshot.accountIds.includes(activeAccountId) ||
      new Set(snapshot.accountIds).size !== snapshot.accountIds.length
    ) {
      return of({
        result: emptyAccountRestoreResult('local-state-unavailable'),
        inactiveAccountIds: [],
      });
    }
    // Alone, so the Active Account is first in the crypto setup queue.
    return this.restoreOne(activeAccountId, 'active').pipe(
      map((outcome) => {
        outcomes.set(activeAccountId, outcome);
        return {
          result: accountRestoreResultFor(activeAccountId, [outcome]),
          inactiveAccountIds: snapshot.accountIds.filter(
            (accountId) => accountId !== activeAccountId,
          ),
        };
      }),
    );
  }

  /**
   * After the start settles: the inactive Accounts, then the native token sweep. Sign-in,
   * switching and lifecycle commands wait for both, so the sweep reads a list no sign-in changed.
   */
  private restoreInBackground(
    accountIds: readonly string[],
    sweepsNativeTokens: boolean,
  ): void {
    if (accountIds.length === 0 && !sweepsNativeTokens) return;
    this.backgroundRestoring = true;
    concat(
      from(accountIds).pipe(
        mergeMap(
          (accountId) =>
            this.restoreOne(accountId, 'inactive').pipe(
              tap((outcome) => {
                this.publishInactiveOutcome(outcome);
                this.lateInactiveOutcomes.next(outcome);
              }),
              catchError((error: unknown) => {
                this.errors.handleError(error);
                return EMPTY;
              }),
            ),
          this.policy.concurrency,
        ),
        ignoreElements(),
      ),
      sweepsNativeTokens
        ? defer(() => this.adapter.sweepNativeTokens()).pipe(
            catchError(() => EMPTY),
          )
        : EMPTY,
    )
      .pipe(
        finalize(() => (this.backgroundRestoring = false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
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
      : { ...outcome, accountId, placement: intent.placement };
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
