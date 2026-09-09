import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateRequiredResult, main } from './ci-required-result.mjs';

const classification = {
  mode: 'code',
  reason: 'code changes',
  expectedJobs: [
    'quality',
    'unit-and-types',
    'renderer',
    'component-storybook-e2e',
    'component-styling-e2e',
    'browser-synapse-e2e',
    'qr-protocol-e2e',
    'production-renderer-e2e',
    'web-container',
    'desktop-e2e',
    'android-e2e',
    'ios-native-build',
  ],
};
const successfulNeeds = Object.fromEntries(
  classification.expectedJobs.map((job) => [job, 'success']),
);
successfulNeeds.classify = 'success';

describe('required CI result evaluator', () => {
  it('accepts the current expected set when every required job succeeds', () => {
    expect(evaluateRequiredResult(classification, successfulNeeds)).toEqual({
      ok: true,
      failures: [],
    });
  });

  it.each(
    classification.expectedJobs.flatMap((job) =>
      ['failure', 'cancelled', 'skipped', 'missing'].map((kind) => [job, kind]),
    ),
  )('rejects %s with a %s result', (job, kind) => {
    const needs = { ...successfulNeeds };
    if (kind === 'missing') delete needs[job];
    else needs[job] = kind;
    expect(evaluateRequiredResult(classification, needs).ok).toBe(false);
  });

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

  it('rejects a missing classifier result even when all suites passed', () => {
    const needs = { ...successfulNeeds };
    delete needs.classify;
    expect(evaluateRequiredResult(classification, needs)).toEqual({
      ok: false,
      failures: ['classify: missing'],
    });
  });

  it('accepts the canonical docs-only set', () => {
    expect(
      evaluateRequiredResult(
        { mode: 'docs', expectedJobs: ['docs-gate'] },
        { classify: 'success', 'docs-gate': 'success' },
      ),
    ).toEqual({ ok: true, failures: [] });
  });

  it.each([
    ['duplicate', ['quality', 'quality']],
    ['tampered', ['quality']],
    ['missing', undefined],
  ])('rejects a %s expected job set', (_name, expectedJobs) => {
    expect(
      evaluateRequiredResult(
        { ...classification, expectedJobs },
        successfulNeeds,
      ).ok,
    ).toBe(false);
  });

  it.each([undefined, 'failure'])(
    'keeps the full summary when source is %s',
    (sourceResult) => {
      const directory = mkdtempSync(join(tmpdir(), 'trinity-required-'));
      const summary = join(directory, 'summary.md');
      const output = join(directory, 'output');
      const result = main({
        env: {
          CI_CLASSIFICATION_JSON: JSON.stringify(classification),
          CI_NEEDS_JSON: JSON.stringify(successfulNeeds),
          ...(sourceResult === undefined
            ? {}
            : { CI_SOURCE_RESULT: sourceResult }),
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_OUTPUT: output,
        },
      });
      expect(result.ok).toBe(false);
      const contents = readFileSync(summary, 'utf8');
      expect(contents).toContain('master source guard');
      for (const job of classification.expectedJobs)
        expect(contents).toContain(job);
      expect(contents).toContain('classify');
      expect(readFileSync(output, 'utf8')).toContain('result=failure');
    },
  );

  it('rejects malformed evaluator JSON', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-required-'));
    const summary = join(directory, 'summary.md');
    const output = join(directory, 'output');
    const result = main({
      env: {
        CI_CLASSIFICATION_JSON: '{',
        CI_NEEDS_JSON: '{}',
        CI_SOURCE_RESULT: 'success',
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: output,
      },
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(summary, 'utf8')).toContain(
      'classifier input was malformed',
    );
    expect(existsSync(output)).toBe(false);
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
