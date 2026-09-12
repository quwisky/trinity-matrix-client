import { describe, expect, it } from 'vitest';
import { evaluateRequiredResult } from './ci-required-result.mjs';

const classification = {
  mode: 'code',
  reason: 'code changes',
  expectedJobs: [
    'quality',
    'docs-gate',
    'test',
    'renderer',
    'desktop',
    'e2e',
    'android-e2e',
    'ios-native-build',
  ],
};
const successfulNeeds = Object.fromEntries(
  classification.expectedJobs.map((job) => [job, 'success']),
);

describe('required CI result evaluator', () => {
  it('accepts the current expected set when every required job succeeds', () => {
    expect(evaluateRequiredResult(classification, successfulNeeds)).toEqual({
      ok: true,
      failures: [],
    });
  });

  it.each(['failure', 'missing', 'cancelled', 'skipped'])(
    'rejects a %s required result',
    (kind) => {
      const needs = { ...successfulNeeds };
      if (kind === 'missing') delete needs.test;
      else needs.test = kind === 'failure' ? 'failure' : kind;
      expect(evaluateRequiredResult(classification, needs).ok).toBe(false);
    },
  );

  it('rejects a tampered expected job set and classifier failure', () => {
    expect(
      evaluateRequiredResult(
        { ...classification, expectedJobs: ['quality'] },
        successfulNeeds,
      ).ok,
    ).toBe(false);
    expect(
      evaluateRequiredResult(
        { ...classification, classifierFailed: true },
        successfulNeeds,
      ).ok,
    ).toBe(false);
  });

  it('ignores unrelated jobs from another branch', () => {
    expect(
      evaluateRequiredResult(
        { ...classification },
        { ...successfulNeeds, docs: 'skipped' },
      ),
    ).toEqual({ ok: true, failures: [] });
  });

  it.each(['failure', 'cancelled', 'skipped'])(
    'rejects an explicitly failed classifier job: %s',
    (status) => {
      const docsClassification = {
        mode: 'docs',
        reason: 'documentation-only changes',
        expectedJobs: ['docs-gate'],
      };
      expect(
        evaluateRequiredResult(docsClassification, {
          classify: { result: status },
          'docs-gate': { result: 'success' },
        }).ok,
      ).toBe(false);
    },
  );
});
