import { describe, expect, it } from 'vitest';
import { assessProof } from './ci-diagnostics-proof.mjs';

describe('CI diagnostic proof assertions', () => {
  it('rejects a retry that accidentally leaves the command green', () => {
    expect(
      assessProof({
        scenario: 'retry',
        exitCode: 0,
        status: 'flaky',
        hasReports: true,
      }),
    ).toContain('failed or flaky fixture returned success');
    expect(
      assessProof({
        scenario: 'retry',
        exitCode: 1,
        status: 'flaky',
        hasReports: true,
      }),
    ).toEqual([]);
  });
  it('rejects startup failures masquerading as the intended failing test', () => {
    expect(
      assessProof({ scenario: 'always-fail', exitCode: 1, hasReports: true }),
    ).toContain('fixture did not fail as intended');
  });
  it('requires interruption of a started test rather than a hang after reporting', () => {
    expect(
      assessProof({
        scenario: 'soft-timeout',
        exitCode: 124,
        status: 'unexpected',
        hasReports: true,
        started: true,
      }),
    ).toContain('wrapper did not interrupt an active Playwright test');
    expect(
      assessProof({
        scenario: 'soft-timeout',
        exitCode: 124,
        status: 'interrupted',
        hasReports: true,
        started: true,
      }),
    ).toEqual([]);
  });
  it('requires missing reports despite a passing test command', () => {
    expect(
      assessProof({
        scenario: 'missing-report',
        exitCode: 0,
        status: 'expected',
        hasReports: false,
      }),
    ).toEqual([]);
    expect(
      assessProof({
        scenario: 'missing-report',
        exitCode: 0,
        status: 'expected',
        hasReports: true,
      }),
    ).toEqual(['missing report root was accepted']);
  });
});
