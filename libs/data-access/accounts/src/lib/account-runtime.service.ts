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
  private readonly backgroundRestoring = signal(false);
  private readonly pendingRestores = signal<ReadonlySet<string>>(new Set());
  /** The last start's result, kept past a switch so a failed inactive Account stays retryable. */
  private startResult: AccountRestoreResult | null = null;

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
  /**
   * The inactive Accounts still restoring after a start, in its background run or a retry;
   * each leaves as it settles.
   */
  readonly restoringAccountIds = computed<ReadonlySet<string>>(
    () =>
      new Set([...this.pendingRestores(), ...this.inactiveRestore.retrying()]),
  );
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
              background: null,
            });
          }
          activeAccountId = snapshot.activeAccountId;
          totalAccounts = snapshot.accountIds.length;
          this.publishProgress(activeAccountId, totalAccounts, outcomes);
          return this.restoreActive(snapshot, outcomes);
        }),
        // Without a background run, still restoring, so no sign-in can start until the sweep
        // has read its list.
        switchMap((restored) =>
          restored.background ||
          !sweepsNativeTokens ||
          restored.result.kind === 'local-state-unavailable'
            ? of(restored)
            : this.adapter.sweepNativeTokens().pipe(
                catchError(() => of(void 0)),
                map(() => restored),
              ),
        ),
        tap(({ result, background }) => {
          termination = 'settled';
          this.startResult = result;
          this.runtimeState.set({ phase: 'settled', result });
          if (background) {
            this.restoreInBackground(background, sweepsNativeTokens);
          }
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
      const result = this.startResult;
      if (
        !result ||
        (result.kind !== 'restored-with-inactive-failures' &&
          result.kind !== 'restored')
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
        this.blockingSwitchOperation(accountId),
        coordination.prepare,
        coordination.onCommitStarted ?? (() => undefined),
        (state) => this.runtimeState.set(state),
      ),
    );
  }

  signOutAccount(accountId: string): Observable<AccountSignOutOutcome> {
    return defer(() => {
      const blocking = this.blockingLifecycleOperation();
      if (!blocking) this.forgetStarted(accountId);
      return this.lifecycleWorkflow.signOut(accountId, blocking);
    });
  }

  /** Remove an account its homeserver deleted, serialized with the other lifecycle commands. */
  removeDeletedAccount(accountId: string): Observable<AccountSignOutOutcome> {
    return defer(() => {
      const blocking = this.blockingLifecycleOperation();
      if (!blocking) this.forgetStarted(accountId);
      return this.lifecycleWorkflow.removeDeleted(accountId, blocking);
    });
  }

  /** Whether inactive Accounts are still restoring after the start, or being retried. */
  restoringInBackground(): boolean {
    return (
      this.backgroundRestoring() || this.inactiveRestore.retrying().size > 0
    );
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

  private blockingSwitchOperation(
    accountId: string,
  ): Exclude<AccountRuntimeOperation, 'switching-account'> | null {
    // Only the target's own restore holds a switch back; a settled Account switches at once.
    const operation = this.restoringAccountIds().has(accountId)
      ? this.currentOperation()
      : this.currentOperation(false);
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

  /**
   * An Account a sign-out or removal starts on leaves the start's result, so a retry never
   * restores it again, even when that command then fails: a later start restores it if it stays.
   */
  private forgetStarted(accountId: string): void {
    const result = this.startResult;
    if (!result || !('activeAccountId' in result)) return;
    this.startResult =
      accountId === result.activeAccountId
        ? null
        : accountRestoreResultFor(
            result.activeAccountId,
            result.accounts.filter(
              (account) => account.accountId !== accountId,
            ),
          );
  }

  /** Into the start's result whatever the phase, and into the runtime state while it shows it. */
  private publishInactiveOutcome(outcome: AccountRestoreOutcome): void {
    const result = this.startResult;
    if (
      !result ||
      (result.kind !== 'restored-with-inactive-failures' &&
        result.kind !== 'restored' &&
        result.kind !== 'active-account-unavailable')
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
    this.startResult = accountRestoreResultFor(
      result.activeAccountId,
      accounts,
    );
    if (this.runtimeState().phase === 'settled') {
      this.runtimeState.set({ phase: 'settled', result: this.startResult });
    }
  }

  /**
   * Settles once the Active Account is ready, naming the inactive Accounts left for the
   * background. When it is not ready, the start is blocked anyway, so the inactive Accounts
   * restore inside it and the recovery commands are not refused by a background run.
   */
  private restoreActive(
    snapshot: Extract<SavedAccountsSnapshot, { kind: 'available' }>,
    outcomes: Map<string, AccountRestoreOutcome>,
  ): Observable<{
    readonly result: AccountRestoreResult;
    readonly background: readonly string[] | null;
  }> {
    if (snapshot.accountIds.length === 0) {
      return of({
        result: emptyAccountRestoreResult('no-accounts'),
        background: null,
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
        background: null,
      });
    }
    const orderedAccountIds = [
      activeAccountId,
      ...snapshot.accountIds.filter(
        (accountId) => accountId !== activeAccountId,
      ),
    ];
    const record = (outcome: AccountRestoreOutcome): void => {
      outcomes.set(outcome.accountId, outcome);
      this.publishProgress(activeAccountId, orderedAccountIds.length, outcomes);
    };
    // Alone, so the Active Account is first in the crypto setup queue.
    return this.restoreOne(activeAccountId, 'active').pipe(
      tap(record),
      switchMap((active) =>
        active.kind === 'ready'
          ? of({
              result: accountRestoreResultFor(activeAccountId, [active]),
              background: orderedAccountIds.slice(1),
            })
          : from(orderedAccountIds.slice(1)).pipe(
              mergeMap(
                (accountId) =>
                  this.restoreOne(accountId, 'inactive').pipe(tap(record)),
                this.policy.concurrency,
              ),
              toArray(),
              map(() => ({
                result: accountRestoreResultFor(
                  activeAccountId,
                  orderedAccountIds.map((accountId) =>
                    outcomes.get(accountId)!,
                  ),
                ),
                background: null,
              })),
            ),
      ),
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
    this.backgroundRestoring.set(true);
    this.pendingRestores.set(new Set(accountIds));
    concat(
      from(accountIds).pipe(
        mergeMap(
          (accountId) =>
            this.restoreOne(accountId, 'inactive').pipe(
              catchError((error: unknown) => {
                this.errors.handleError(error);
                // An outcome all the same, so health reports it and a retry can reach it.
                return of({
                  kind: 'failed' as const,
                  failure: 'unexpected' as const,
                  accountId,
                  role: 'inactive' as const,
                });
              }),
              tap((outcome) => {
                this.publishInactiveOutcome(outcome);
                this.pendingRestores.update((pending) => {
                  const next = new Set(pending);
                  next.delete(accountId);
                  return next;
                });
                this.lateInactiveOutcomes.next(outcome);
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
        finalize(() => {
          this.pendingRestores.set(new Set());
          this.backgroundRestoring.set(false);
        }),
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
