import { Injectable, inject } from '@angular/core';
import {
  Observable,
  defer,
  finalize,
  of,
  shareReplay,
  take,
  throwIfEmpty,
} from 'rxjs';
import { ACCOUNT_RUNTIME_ADAPTER } from './account-runtime.adapter';
import type {
  AccountLifecycleOperation,
  AccountRuntimeOperation,
  AccountSignOutOutcome,
  InstallationResetOutcome,
} from './account-runtime.models';

type BlockingOperation = Exclude<
  AccountRuntimeOperation,
  AccountLifecycleOperation
>;

type InFlightLifecycle =
  | {
      readonly kind: 'sign-out';
      readonly accountId: string;
      readonly outcome: Observable<AccountSignOutOutcome>;
    }
  | {
      readonly kind: 'reset';
      readonly outcome: Observable<InstallationResetOutcome>;
    };

/** Serializes destructive Account lifecycle commands and joins identical attempts. */
@Injectable({ providedIn: 'root' })
export class AccountLifecycleWorkflow {
  private readonly adapter = inject(ACCOUNT_RUNTIME_ADAPTER);
  private attempt: InFlightLifecycle | null = null;

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
          ? this.attempt.outcome
          : of(this.signOutTransition(accountId, this.operation!));
      }
      const outcome = this.adapter.signOutAccount(accountId).pipe(
        take(1),
        throwIfEmpty(() => new Error('Account sign-out emitted no outcome.')),
        finalize(() => {
          if (this.attempt?.outcome === outcome) this.attempt = null;
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
      this.attempt = { kind: 'sign-out', accountId, outcome };
      return outcome;
    });
  }

  reset(
    blocking: BlockingOperation | null,
  ): Observable<InstallationResetOutcome> {
    return defer(() => {
      if (blocking)
        return of({
          kind: 'transition-in-progress' as const,
          operation: blocking,
        });
      if (this.attempt) {
        return this.attempt.kind === 'reset'
          ? this.attempt.outcome
          : of({
              kind: 'transition-in-progress' as const,
              operation: this.operation!,
            });
      }
      const outcome = this.adapter.resetInstallation().pipe(
        take(1),
        throwIfEmpty(() => new Error('Installation reset emitted no outcome.')),
        finalize(() => {
          if (this.attempt?.outcome === outcome) this.attempt = null;
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
      this.attempt = { kind: 'reset', outcome };
      return outcome;
    });
  }

  private signOutTransition(
    accountId: string,
    operation: AccountRuntimeOperation,
  ): AccountSignOutOutcome {
    return { kind: 'transition-in-progress', accountId, operation };
  }
}
