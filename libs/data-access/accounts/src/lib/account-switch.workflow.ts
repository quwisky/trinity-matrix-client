import { Injectable, Signal, inject } from '@angular/core';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import {
  Observable,
  catchError,
  defer,
  finalize,
  map,
  of,
  shareReplay,
  switchMap,
  take,
  tap,
  throwError,
  throwIfEmpty,
} from 'rxjs';
import {
  ACCOUNT_RUNTIME_ADAPTER,
  type AdapterAccountSwitchOutcome,
} from './account-runtime.adapter';
import type {
  AccountRuntimeOperation,
  AccountRuntimeState,
  AccountSwitchOutcome,
} from './account-runtime.models';

type BlockingAccountOperation = Exclude<
  AccountRuntimeOperation,
  'switching-account'
>;

interface InFlightAccountSwitch {
  readonly accountId: string;
  outcome: Observable<AccountSwitchOutcome>;
}

/** Internal state machine for the prepare -> commit -> projection switch workflow. */
@Injectable({ providedIn: 'root' })
export class AccountSwitchWorkflow {
  private readonly adapter = inject(ACCOUNT_RUNTIME_ADAPTER);
  private readonly projections = inject(ProjectionRuntime);
  private attempt: InFlightAccountSwitch | null = null;

  get inProgress(): boolean {
    return this.attempt !== null;
  }

  run(
    accountId: string,
    activeAccountId: Signal<string | null>,
    blockingOperation: BlockingAccountOperation | null,
    prepare: () => Observable<void>,
    publish: (state: AccountRuntimeState) => void,
  ): Observable<AccountSwitchOutcome> {
    return defer(() => {
      const startedAt = performance.now();
      if (this.attempt) {
        return this.attempt.accountId === accountId
          ? this.attempt.outcome
          : of({
              kind: 'transition-in-progress',
              accountId,
              operation: 'switching-account',
            } as const);
      }
      if (activeAccountId() === accountId) {
        return of({
          kind: 'ready',
          accountId,
          metrics: {
            durationMs: performance.now() - startedAt,
            projectionDurationMs: 0,
            projectionCount: 0,
          },
        } as const);
      }
      if (blockingOperation) {
        return of({
          kind: 'transition-in-progress',
          accountId,
          operation: blockingOperation,
        } as const);
      }

      let commitStarted = false;
      let settled = false;
      publish({ phase: 'switching', accountId });
      const prepared = defer(prepare).pipe(
        switchMap(() => this.adapter.prepareActiveAccount(accountId)),
        take(1),
        throwIfEmpty(
          () =>
            new Error('Account Runtime switch preparation emitted no outcome.'),
        ),
        switchMap((preparation) => {
          if (preparation.kind === 'failed') {
            return of(this.failed(accountId, preparation));
          }
          commitStarted = true;
          const committed = this.commit(accountId, startedAt).pipe(
            tap((outcome) => {
              settled = true;
              publish({ phase: 'switch-settled', outcome });
            }),
            catchError((error: unknown) => {
              publish({ phase: 'switch-failed', accountId });
              return throwError(() => error);
            }),
            finalize(() => {
              if (this.attempt?.outcome === committed) this.attempt = null;
            }),
            shareReplay({ bufferSize: 1, refCount: false }),
          );
          if (this.attempt?.accountId === accountId) {
            this.attempt.outcome = committed;
          }
          return committed;
        }),
        tap((outcome) => {
          if (!commitStarted) {
            settled = true;
            publish({ phase: 'switch-settled', outcome });
          }
        }),
        finalize(() => {
          if (commitStarted) return;
          if (this.attempt?.outcome === prepared) this.attempt = null;
          if (!settled) publish({ phase: 'switch-cancelled', accountId });
        }),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
      this.attempt = { accountId, outcome: prepared };
      return prepared;
    });
  }

  private commit(
    accountId: string,
    startedAt: number,
  ): Observable<AccountSwitchOutcome> {
    return this.adapter.commitActiveAccount(accountId).pipe(
      take(1),
      throwIfEmpty(
        () => new Error('Account Runtime switch commit emitted no outcome.'),
      ),
      switchMap((commit) => {
        if (commit.kind === 'failed') return of(this.failed(accountId, commit));
        const projectionStartedAt = performance.now();
        return this.projections.transition({ kind: 'active-account' }).pipe(
          map((readiness) => ({
            kind: 'ready' as const,
            accountId,
            metrics: {
              durationMs: performance.now() - startedAt,
              projectionDurationMs: performance.now() - projectionStartedAt,
              projectionCount: readiness.projectionCount,
            },
          })),
        );
      }),
    );
  }

  private failed(
    accountId: string,
    outcome: Extract<AdapterAccountSwitchOutcome, { kind: 'failed' }>,
  ): AccountSwitchOutcome {
    return { kind: 'failed', accountId, failure: outcome.failure };
  }
}
