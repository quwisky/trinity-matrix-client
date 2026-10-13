import { ROOM_LIBRARY_PREPARATION_BUDGET_MS } from '@trinity/data-access/room-library';
import { describe, expect, it } from 'vitest';
import { APPLICATION_STARTUP_STAGES } from './application-runtime.models';
import {
  APPLICATION_STARTUP_PRODUCER_POLICIES,
  APPLICATION_STARTUP_WATCHDOG_BUDGET_MS,
} from './application-startup.policy';

describe('Application startup producer policy', () => {
  it('registers every current producer, each but the session lock with a finite budget, and no automatic retry', () => {
    expect(Object.keys(APPLICATION_STARTUP_PRODUCER_POLICIES)).toEqual([
      'host-contract',
      'session-lock',
      'preference-hydration',
      'account-registry',
      'room-library',
      'room-order',
      'browser-storage-persistence',
      'workspace',
      'readiness',
    ]);
    const bounded = Object.entries(APPLICATION_STARTUP_PRODUCER_POLICIES)
      .filter(([producer]) => producer !== 'session-lock')
      .map(([, policy]) => policy);
    expect(
      bounded.every(
        (policy) =>
          policy.budgetMs !== null &&
          policy.budgetMs > 0 &&
          policy.automaticRetryLimit === 0,
      ),
    ).toBe(true);
    // A tab may wait for another tab for as long as that tab runs: no deadline.
    expect(APPLICATION_STARTUP_PRODUCER_POLICIES['session-lock']).toEqual({
      stage: 'session-lock',
      required: true,
      budgetMs: null,
      automaticRetryLimit: 0,
    });
    expect(APPLICATION_STARTUP_PRODUCER_POLICIES['room-library'].budgetMs).toBe(
      ROOM_LIBRARY_PREPARATION_BUDGET_MS,
    );
    expect(
      APPLICATION_STARTUP_PRODUCER_POLICIES['preference-hydration'],
    ).toMatchObject({ budgetMs: 10_000, required: false });
  });

  it('budgets the watchdog for every serial stage and its longest parallel producer', () => {
    const completeStagedPath = APPLICATION_STARTUP_STAGES.reduce(
      (total, stage) =>
        total +
        Math.max(
          ...Object.values(APPLICATION_STARTUP_PRODUCER_POLICIES)
            .filter((policy) => policy.stage === stage)
            .map((policy) => policy.budgetMs ?? 0),
        ),
      0,
    );

    expect(APPLICATION_STARTUP_WATCHDOG_BUDGET_MS).toBe(completeStagedPath);
    // Unchanged by the session lock, whose wait is outside the watchdog.
    expect(APPLICATION_STARTUP_WATCHDOG_BUDGET_MS).toBe(230_000);
  });
});
