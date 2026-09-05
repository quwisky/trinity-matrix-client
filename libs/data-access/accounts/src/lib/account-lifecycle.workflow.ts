import { Injectable, inject, signal } from '@angular/core';
import {
  Observable,
  ReplaySubject,
  Subscription,
  defer,
  map,
  of,
  race,
  take,
  timer,
} from 'rxjs';
import { ACCOUNT_RUNTIME_ADAPTER } from './account-runtime.adapter';
import type {
  AccountLifecycleOperation,
  AccountLifecycleState,
  AccountRuntimeOperation,
  AccountSignOutOutcome,
  InstallationResetOutcome,
} from './account-runtime.models';

type BlockingOperation = Exclude<
  AccountRuntimeOperation,
  AccountLifecycleOperation
>;

type LifecycleOutcome = AccountSignOutOutcome | InstallationResetOutcome;

interface OwnedLifecycleBase {
  readonly id: number;
  readonly updates: ReplaySubject<LifecycleOutcome>;
  readonly owner: Subscription;
  latest: LifecycleOutcome | null;
  settled: boolean;
}

type InFlightLifecycle =
  | (OwnedLifecycleBase & {
      readonly kind: 'sign-out';
      readonly accountId: string;
    })
  | (OwnedLifecycleBase & {
      readonly kind: 'reset';
    });

/** Finite caller observation; the accepted destructive attempt remains session-owned. */
export const ACCOUNT_LIFECYCLE_OBSERVATION_BUDGET_MS = 10_000;

/** Serializes destructive Account lifecycle commands and joins identical attempts. */
@Injectable({ providedIn: 'root' })
export class AccountLifecycleWorkflow {
  private readonly adapter = inject(ACCOUNT_RUNTIME_ADAPTER);
  private readonly lifecycleState = signal<AccountLifecycleState>({
    phase: 'idle',
  });
  private attempt: InFlightLifecycle | null = null;
  private nextAttempt = 0;
  private readonly signOutSettlements = new Map<
    string,
    Extract<AccountSignOutOutcome, { readonly kind: 'partial-cleanup' }>
  >();
  private resetSettlement: Extract<
    InstallationResetOutcome,
    { readonly kind: 'ready' | 'partial-cleanup' }
  > | null = null;

  readonly state = this.lifecycleState.asReadonly();

  get operation(): AccountLifecycleOperation | null {
    if (!this.attempt) return null;
    return this.attempt.kind === 'sign-out'
      ? 'signing-out-account'
      : 'resetting-installation';
  }

  signOut(
    accountId: string,
    blocking: BlockingOperation | null,
  ): Observable<AccountSignOutOutcome> {
    return defer(() => {
      if (blocking) return of(this.signOutTransition(accountId, blocking));
      if (this.attempt) {
        return this.attempt.kind === 'sign-out' &&
          this.attempt.accountId === accountId
          ? this.observe<AccountSignOutOutcome>(this.attempt)
          : of(this.signOutTransition(accountId, this.operation!));
      }
      const attempt = this.startSignOut(accountId);
      return this.observe<AccountSignOutOutcome>(attempt);
    });
  }

  reset(
    blocking: BlockingOperation | null,
  ): Observable<InstallationResetOutcome> {
    return defer(() => {
      if (blocking) {
        return of({
          kind: 'transition-in-progress' as const,
          operation: blocking,
        });
      }
      if (this.attempt) {
        return this.attempt.kind === 'reset'
          ? this.observe<InstallationResetOutcome>(this.attempt)
          : of({
              kind: 'transition-in-progress' as const,
              operation: this.operation!,
            });
      }
      if (this.resetSettlement?.kind === 'ready') {
        return of(this.resetSettlement);
      }
      const attempt = this.startReset();
      return this.observe<InstallationResetOutcome>(attempt);
    });
  }

  private startSignOut(
    accountId: string,
  ): Extract<InFlightLifecycle, { readonly kind: 'sign-out' }> {
    const attempt = {
      id: ++this.nextAttempt,
      kind: 'sign-out' as const,
      accountId,
      updates: new ReplaySubject<LifecycleOutcome>(1),
      owner: new Subscription(),
      latest: null,
      settled: false,
    };
    this.attempt = attempt;
    const residue = this.signOutSettlements.get(accountId);
    this.own(
      attempt,
      defer(() =>
        residue
          ? this.adapter.retrySignOutCleanup(accountId, residue.issues)
          : this.adapter.signOutAccount(accountId),
      ),
    );
    return attempt;
  }

  private startReset(): Extract<InFlightLifecycle, { readonly kind: 'reset' }> {
    const attempt = {
      id: ++this.nextAttempt,
      kind: 'reset' as const,
      updates: new ReplaySubject<LifecycleOutcome>(1),
      owner: new Subscription(),
      latest: null,
      settled: false,
    };
    this.attempt = attempt;
    this.own(
      attempt,
      defer(() =>
        this.resetSettlement?.kind === 'partial-cleanup'
          ? this.adapter.retryInstallationCleanup(this.resetSettlement.issues)
          : this.adapter.resetInstallation(),
      ),
    );
    return attempt;
  }

  private own<TOutcome extends LifecycleOutcome>(
    attempt: InFlightLifecycle,
    source: Observable<TOutcome>,
  ): void {
    attempt.owner.add(
      source.subscribe({
        next: (outcome) => this.accept(attempt, outcome),
        error: () => {
          this.accept(attempt, this.faultOutcome(attempt));
          this.release(attempt);
        },
        complete: () => {
          if (!attempt.settled) {
            this.accept(attempt, this.faultOutcome(attempt));
          }
          this.release(attempt);
        },
      }),
    );
  }

  private accept(attempt: InFlightLifecycle, outcome: LifecycleOutcome): void {
    if (attempt.settled) return;
    attempt.latest = outcome;
    const operation =
      attempt.kind === 'sign-out'
        ? 'signing-out-account'
        : 'resetting-installation';
    this.lifecycleState.set({
      phase: outcome.kind === 'uncertain-cleanup' ? 'running' : 'settled',
      attempt: attempt.id,
      operation,
      outcome,
    });
    attempt.updates.next(outcome);
    if (outcome.kind === 'uncertain-cleanup') return;
    attempt.settled = true;
    if (attempt.kind === 'reset') {
      if (outcome.kind === 'ready' || outcome.kind === 'partial-cleanup') {
        this.resetSettlement = outcome;
      }
    } else if (outcome.kind === 'ready') {
      this.signOutSettlements.delete(attempt.accountId);
    } else if (outcome.kind === 'partial-cleanup') {
      this.signOutSettlements.set(
        attempt.accountId,
        outcome as Extract<
          AccountSignOutOutcome,
          { readonly kind: 'partial-cleanup' }
        >,
      );
    }
    attempt.updates.complete();
  }

  private faultOutcome(attempt: InFlightLifecycle): LifecycleOutcome {
    return attempt.kind === 'sign-out'
      ? {
          kind: 'failed',
          accountId: (
            attempt as Extract<InFlightLifecycle, { kind: 'sign-out' }>
          ).accountId,
          failure: 'local-state-unavailable',
          recovery: 'retry-sign-out',
        }
      : {
          kind: 'partial-cleanup',
          issues: [
            {
              scope: 'account-registry',
              recovery: 'retry-installation-reset',
            },
          ],
        };
  }

  private observe<TOutcome extends LifecycleOutcome>(
    attempt: InFlightLifecycle,
  ): Observable<TOutcome> {
    return race(
      attempt.updates,
      timer(ACCOUNT_LIFECYCLE_OBSERVATION_BUDGET_MS).pipe(
        map(
          () => (attempt.latest ?? this.uncertainFallback(attempt)) as TOutcome,
        ),
      ),
    ).pipe(
      take(1),
      map((outcome) => outcome as TOutcome),
    );
  }

  private uncertainFallback(attempt: InFlightLifecycle): LifecycleOutcome {
    const pending = [
      {
        scope: 'account-registry' as const,
        recovery:
          attempt.kind === 'sign-out'
            ? ('retry-sign-out' as const)
            : ('retry-installation-reset' as const),
      },
    ];
    return attempt.kind === 'sign-out'
      ? {
          kind: 'uncertain-cleanup',
          accountId: (
            attempt as unknown as Extract<
              InFlightLifecycle,
              { kind: 'sign-out' }
            >
          ).accountId,
          issues: [],
          pending,
        }
      : { kind: 'uncertain-cleanup', issues: [], pending };
  }

  private release(attempt: OwnedLifecycleBase): void {
    if (this.attempt !== attempt) return;
    this.attempt = null;
    attempt.owner.unsubscribe();
  }

  private signOutTransition(
    accountId: string,
    operation: AccountRuntimeOperation,
  ): AccountSignOutOutcome {
    return { kind: 'transition-in-progress', accountId, operation };
  }
}
