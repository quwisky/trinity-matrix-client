import { describe, expect, it } from 'vitest';
import { evaluateVitestReport } from './report.mts';

const report = (passed: number, failed: number, pending: number): string =>
  JSON.stringify({
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: pending,
  });

describe('evaluateVitestReport', () => {
  it('accepts a report where everything passed', () => {
    expect(evaluateVitestReport('lib', report(7, 0, 0)).ok).toBe(true);
  });

  it('rejects a report with no passed tests', () => {
    expect(evaluateVitestReport('lib', report(0, 0, 0)).ok).toBe(false);
  });

  it('rejects a report with any skipped test', () => {
    expect(evaluateVitestReport('lib', report(6, 0, 1)).ok).toBe(false);
  });

  it('rejects a report with a failed test', () => {
    expect(evaluateVitestReport('lib', report(6, 1, 0)).ok).toBe(false);
  });

  it('rejects a missing or unreadable report', () => {
    expect(evaluateVitestReport('lib', undefined).ok).toBe(false);
    expect(evaluateVitestReport('lib', '{').ok).toBe(false);
  });
});
