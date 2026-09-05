import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDetachedCleanupAttempt } from './account-cleanup-attempt';

type Outcome =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'partial';
      readonly issues: readonly unknown[];
    }
  | {
      readonly kind: 'uncertain';
      readonly issues: readonly unknown[];
      readonly pending: readonly unknown[];
    };

describe('runDetachedCleanupAttempt', () => {
  afterEach(() => vi.useRealTimers());

  it('bounds observation without cancelling the owned operation', async () => {
    vi.useFakeTimers();
    const source = new Subject<void>();
    const outcomes: Outcome[] = [];
    runDetachedCleanupAttempt<Outcome>(
      (issues, pending) => ({ kind: 'uncertain', issues, pending }),
      (attempt) =>
        attempt.step(source, {
          budgetMs: 50,
          scope: 'indexed-db',
          recovery: 'restart-application',
        }),
      (attempt) => {
        const issues = attempt.settledIssues();
        return issues.length === 0
          ? { kind: 'ready' }
          : { kind: 'partial', issues };
      },
      () => ({ kind: 'partial', issues: [] }),
    ).subscribe((outcome) => outcomes.push(outcome));

    await vi.advanceTimersByTimeAsync(50);
    expect(outcomes).toEqual([
      {
        kind: 'uncertain',
        issues: [],
        pending: [{ scope: 'indexed-db', recovery: 'restart-application' }],
      },
    ]);
    expect(source.observed).toBe(true);

    source.next();
    source.complete();
    expect(outcomes.at(-1)).toEqual({ kind: 'ready' });
  });

  it('settles failures as value-free residue and continues siblings', () => {
    const outcomes: Outcome[] = [];
    runDetachedCleanupAttempt<Outcome>(
      (issues, pending) => ({ kind: 'uncertain', issues, pending }),
      (attempt) =>
        attempt.step(of(void 0), {
          budgetMs: 50,
          scope: 'preferences',
          recovery: 'retry-installation-reset',
          onSettled: () =>
            attempt.addIssue('secure-storage', 'retry-installation-reset'),
        }),
      (attempt) => ({
        kind: 'partial',
        issues: attempt.settledIssues(),
      }),
      () => ({ kind: 'partial', issues: [] }),
    ).subscribe((outcome) => outcomes.push(outcome));

    expect(outcomes).toEqual([
      {
        kind: 'partial',
        issues: [
          {
            scope: 'secure-storage',
            recovery: 'retry-installation-reset',
          },
        ],
      },
    ]);
  });

  it('converts an unexpected workflow fault to a typed terminal outcome', () => {
    const outcomes: Outcome[] = [];

    runDetachedCleanupAttempt<Outcome>(
      (issues, pending) => ({ kind: 'uncertain', issues, pending }),
      () => throwError(() => new Error('adapter defect')),
      () => ({ kind: 'ready' }),
      () => ({ kind: 'partial', issues: [] }),
    ).subscribe((outcome) => outcomes.push(outcome));

    expect(outcomes).toEqual([{ kind: 'partial', issues: [] }]);
  });
});
