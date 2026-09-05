import { ROOM_LIBRARY_PREPARATION_BUDGET_MS } from '@trinity/data-access/room-library';
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_STARTUP_PRODUCER_POLICIES,
  APPLICATION_STARTUP_WATCHDOG_BUDGET_MS,
  REQUIRED_STARTUP_PRODUCER_COMPATIBILITY,
} from './application-startup.policy';

describe('Application startup producer policy', () => {
  it('registers every current producer with a finite budget and no automatic retry', () => {
    expect(Object.keys(APPLICATION_STARTUP_PRODUCER_POLICIES)).toEqual([
      'host-contract',
      'account-registry',
      'room-library',
      'room-order',
      'browser-storage-persistence',
      'workspace',
      'readiness',
    ]);
    expect(
      Object.values(APPLICATION_STARTUP_PRODUCER_POLICIES).every(
        (policy) => policy.budgetMs > 0 && policy.automaticRetryLimit === 0,
      ),
    ).toBe(true);
    expect(APPLICATION_STARTUP_PRODUCER_POLICIES['room-library'].budgetMs).toBe(
      ROOM_LIBRARY_PREPARATION_BUDGET_MS,
    );
    expect(REQUIRED_STARTUP_PRODUCER_COMPATIBILITY).toHaveLength(0);
  });

  it('budgets the watchdog beyond the full required staged path', () => {
    const requiredPath = Object.values(APPLICATION_STARTUP_PRODUCER_POLICIES)
      .filter((policy) => policy.required)
      .reduce((total, policy) => total + policy.budgetMs, 0);

    expect(APPLICATION_STARTUP_WATCHDOG_BUDGET_MS).toBeGreaterThan(
      requiredPath,
    );
  });
});
