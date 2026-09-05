import { Injectable, inject } from '@angular/core';
import {
  AccountRuntimeService,
  type AccountRestoreOutcome,
} from '@trinity/data-access/accounts';
import type {
  CapabilityContext,
  CapabilityHealthFact,
  CapabilityRecoveryOutcome,
} from '@trinity/runtime/projection';
import { Observable, catchError, defaultIfEmpty, map, of, take } from 'rxjs';
import { CapabilityHealthService } from '../capability-health.service';

/** Keeps concrete Account identity inside composition while publishing opaque health scopes. */
@Injectable({ providedIn: 'root' })
export class AccountStartupHealthService {
  private readonly accounts = inject(AccountRuntimeService);
  private readonly health = inject(CapabilityHealthService);
  private readonly contexts = new Map<string, CapabilityContext>();
  private readonly generations = new Map<string, number>();

  report(outcomes: readonly AccountRestoreOutcome[]): void {
    for (const outcome of outcomes) {
      if (outcome.role === 'inactive' && outcome.kind !== 'ready') {
        this.reportOne(outcome);
      }
    }
  }

  private reportOne(outcome: AccountRestoreOutcome): void {
    const accountId = outcome.accountId;
    const context = this.contexts.get(accountId) ?? Symbol('account-health');
    this.contexts.set(accountId, context);
    this.health.presentForAccount(context, accountId);
    const generation = (this.generations.get(accountId) ?? 0) + 1;
    this.generations.set(accountId, generation);
    const available = outcome.kind === 'ready';
    const fact = {
      capability: 'accounts',
      operation: 'restore',
      context,
      generation,
      demanded: true,
      preparation: available ? 'acknowledged' : 'failed',
      ownership: 'retained',
      condition: available ? 'available' : 'degraded',
      code: available ? 'account-restore-ready' : restoreCode(outcome),
    } satisfies CapabilityHealthFact;
    this.health.report(fact, () => this.recover(accountId, generation));
  }

  private recover(
    accountId: string,
    generation: number,
  ): Observable<CapabilityRecoveryOutcome> {
    return this.accounts.retryInactiveAccount(accountId).pipe(
      take(1),
      defaultIfEmpty({ kind: 'unavailable' } as const),
      map((outcome): CapabilityRecoveryOutcome => {
        if (this.generations.get(accountId) !== generation) {
          return { kind: 'transition-in-progress' };
        }
        if (
          outcome.kind === 'unavailable' ||
          outcome.kind === 'transition-in-progress'
        ) {
          return outcome;
        }
        this.reportOne(outcome);
        return outcome.kind === 'ready'
          ? { kind: 'success' }
          : { kind: 'failure' };
      }),
      catchError(() => of({ kind: 'failure' } as const)),
    );
  }
}

function restoreCode(outcome: AccountRestoreOutcome): string {
  switch (outcome.kind) {
    case 'ready':
      return 'account-restore-ready';
    case 'reauthentication-required':
      return 'account-reauthentication-required';
    case 'timed-out':
      return 'account-restoration-timeout';
    case 'failed':
      return `account-restore-${outcome.failure}`;
  }
}
