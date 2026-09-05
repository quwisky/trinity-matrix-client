import {
  Observable,
  ReplaySubject,
  Subscription,
  defer,
  race,
  timer,
} from 'rxjs';
import { defaultIfEmpty, map, take } from 'rxjs/operators';
import type {
  AccountCleanupIssue,
  AccountCleanupPending,
  AccountCleanupRecovery,
  AccountCleanupScope,
} from './account-runtime.models';

interface StepSettlement<T> {
  readonly ok: boolean;
  readonly value?: T;
}

export interface AccountCleanupStepOptions<T> {
  readonly budgetMs: number;
  readonly scope: AccountCleanupScope;
  readonly recovery: AccountCleanupRecovery;
  readonly waitAfterBudget?: boolean;
  readonly fallback?: T;
  readonly onTimeout?: () => void;
  readonly onSettled?: (value: T) => void;
}

type UncertainOutcome<TOutcome> = (
  issues: readonly AccountCleanupIssue[],
  pending: readonly AccountCleanupPending[],
) => TOutcome;

/**
 * Owns cleanup subscriptions independently of their bounded observation.
 *
 * A timer changes only what the caller can safely report. It never unsubscribes the
 * underlying operation, and the attempt cannot settle while any timed-out step remains live.
 */
export class AccountCleanupAttempt<TOutcome> {
  private readonly owners = new Subscription();
  private readonly pendingCounts = new Map<
    AccountCleanupScope,
    { readonly count: number; readonly recovery: AccountCleanupRecovery }
  >();
  private readonly issueMap = new Map<
    AccountCleanupScope,
    AccountCleanupIssue
  >();
  private activeSteps = 0;
  private dispatchComplete = false;
  private terminal: (() => TOutcome) | null = null;
  private lastProgress = '';

  constructor(
    private readonly subscriber: {
      next(value: TOutcome): void;
      complete(): void;
    },
    private readonly uncertain: UncertainOutcome<TOutcome>,
  ) {}

  /** Run one step, allowing the cleanup sequence to continue at its observation bound. */
  step<T>(
    source: Observable<T>,
    options: AccountCleanupStepOptions<T>,
  ): Observable<T> {
    return defer(() => {
      const completion = new ReplaySubject<StepSettlement<T>>(1);
      this.activeSteps += 1;
      let timedOut = false;
      let settled = false;
      let deadlineOwner: Subscription | null = null;
      const settle = (result: StepSettlement<T>): void => {
        if (settled) return;
        settled = true;
        deadlineOwner?.unsubscribe();
        if (result.ok) {
          try {
            options.onSettled?.(result.value as T);
          } catch {
            this.issueMap.set(options.scope, {
              scope: options.scope,
              recovery: options.recovery,
            });
          }
        }
        if (!result.ok) {
          this.issueMap.set(options.scope, {
            scope: options.scope,
            recovery: options.recovery,
          });
        }
        if (timedOut) this.removePending(options.scope);
        this.activeSteps -= 1;
        completion.next(result);
        completion.complete();
        this.publishProgress();
        this.trySettle();
      };
      this.owners.add(
        source.pipe(take(1), defaultIfEmpty(options.fallback as T)).subscribe({
          next: (value) => settle({ ok: true, value }),
          error: () => settle({ ok: false, value: options.fallback }),
        }),
      );

      const deadline = timer(options.budgetMs).pipe(
        map((): StepSettlement<T> => {
          if (!settled) {
            timedOut = true;
            this.addPending(options.scope, options.recovery);
            try {
              options.onTimeout?.();
            } catch {
              this.issueMap.set(options.scope, {
                scope: options.scope,
                recovery: options.recovery,
              });
            }
            this.publishProgress();
          }
          return { ok: true, value: options.fallback };
        }),
      );
      if (options.waitAfterBudget && !settled) {
        deadlineOwner = deadline.subscribe();
        this.owners.add(deadlineOwner);
      }
      const observed = options.waitAfterBudget
        ? completion
        : race(completion, deadline);
      return observed.pipe(map((result) => result.value as T));
    });
  }

  addIssue(scope: AccountCleanupScope, recovery: AccountCleanupRecovery): void {
    this.issueMap.set(scope, { scope, recovery });
  }

  resolveIssue(scope: AccountCleanupScope): void {
    this.issueMap.delete(scope);
  }

  settledIssues(): readonly AccountCleanupIssue[] {
    return [...this.issueMap.values()];
  }

  finish(terminal: () => TOutcome): void {
    this.dispatchComplete = true;
    this.terminal = terminal;
    if (this.activeSteps > 0) this.publishProgress();
    this.trySettle();
  }

  private addPending(
    scope: AccountCleanupScope,
    recovery: AccountCleanupRecovery,
  ): void {
    const current = this.pendingCounts.get(scope);
    this.pendingCounts.set(scope, {
      count: (current?.count ?? 0) + 1,
      recovery,
    });
  }

  private removePending(scope: AccountCleanupScope): void {
    const current = this.pendingCounts.get(scope);
    if (!current || current.count <= 1) this.pendingCounts.delete(scope);
    else
      this.pendingCounts.set(scope, { ...current, count: current.count - 1 });
  }

  private issues(): readonly AccountCleanupIssue[] {
    return [...this.issueMap.values()].filter(
      ({ scope }) => !this.pendingCounts.has(scope),
    );
  }

  private pending(): readonly AccountCleanupPending[] {
    return [...this.pendingCounts].map(([scope, { recovery }]) => ({
      scope,
      recovery,
    }));
  }

  private publishProgress(): void {
    if (this.activeSteps === 0 || this.pendingCounts.size === 0) return;
    const outcome = this.uncertain(this.issues(), this.pending());
    const serialized = JSON.stringify(outcome);
    if (serialized === this.lastProgress) return;
    this.lastProgress = serialized;
    this.subscriber.next(outcome);
  }

  private trySettle(): void {
    if (!this.dispatchComplete || this.activeSteps > 0 || !this.terminal)
      return;
    this.subscriber.next(this.terminal());
    this.subscriber.complete();
    this.owners.unsubscribe();
  }
}

/** Start an owned attempt on subscription; unsubscription detaches only that observer. */
export function runDetachedCleanupAttempt<TOutcome>(
  uncertain: UncertainOutcome<TOutcome>,
  run: (attempt: AccountCleanupAttempt<TOutcome>) => Observable<unknown>,
  terminal: (attempt: AccountCleanupAttempt<TOutcome>) => TOutcome,
  unexpected: (attempt: AccountCleanupAttempt<TOutcome>) => TOutcome,
): Observable<TOutcome> {
  return new Observable<TOutcome>((subscriber) => {
    const attempt = new AccountCleanupAttempt(subscriber, uncertain);
    let workflow: Observable<unknown>;
    try {
      workflow = run(attempt);
    } catch {
      attempt.finish(() => unexpected(attempt));
      return;
    }
    workflow.subscribe({
      complete: () =>
        attempt.finish(() => {
          try {
            return terminal(attempt);
          } catch {
            return unexpected(attempt);
          }
        }),
      error: () => attempt.finish(() => unexpected(attempt)),
    });
    // The attempt owns its work. Detaching this observer must not cancel cleanup.
  });
}
