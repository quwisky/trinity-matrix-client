import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAggregateReport,
  readPlaywrightSuiteSummary,
  suiteSummaryPath,
  writeAggregateReport,
} from './execution-report.mts';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('E2E execution reports', () => {
  it('groups outcomes by environment, capability and contract type', () => {
    const report = buildAggregateReport({
      target: 'e2e-all',
      runId: 'run-12345678',
      startedAt: new Date('2026-08-31T20:00:00.000Z'),
      finishedAt: new Date('2026-08-31T20:00:02.000Z'),
      results: [
        {
          id: 'browser.canonical',
          environment: 'browser',
          capabilities: ['cross-capability'],
          contractTypes: ['journey'],
          ciTier: 'pull-request',
          outcome: 'retry',
          retries: 2,
          durationMs: 1_500,
        },
        {
          id: 'android.installed-webview',
          environment: 'android',
          capabilities: ['composition', 'host'],
          contractTypes: ['host', 'journey'],
          ciTier: 'pull-request',
          outcome: 'unavailable',
          retries: 0,
          durationMs: 0,
        },
      ],
    });

    expect(report.totals).toMatchObject({
      suites: 2,
      retries: 2,
      durationMs: 1_500,
      outcomes: { retry: 1, unavailable: 1 },
    });
    expect(report.byEnvironment.android.outcomes.unavailable).toBe(1);
    expect(report.byCapability.host.outcomes.unavailable).toBe(1);
    expect(report.byContractType.journey).toMatchObject({
      suites: 2,
      retries: 2,
    });
  });

  it('writes one JSON and Markdown aggregate under the invocation run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-e2e-report-'));
    directories.push(directory);
    const report = buildAggregateReport({
      target: 'e2e-pr',
      runId: 'run-12345678',
      startedAt: new Date('2026-08-31T20:00:00.000Z'),
      finishedAt: new Date('2026-08-31T20:00:01.000Z'),
      results: [],
    });

    const files = writeAggregateReport(directory, report);

    expect(JSON.parse(readFileSync(files.json, 'utf8'))).toEqual(report);
    expect(readFileSync(files.markdown, 'utf8')).toContain(
      '# E2E aggregate e2e-pr',
    );
    expect(readFileSync(files.markdown, 'utf8')).toContain('## By environment');
  });

  it('reads and validates suite retry summaries from the standard path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-suite-report-'));
    directories.push(directory);
    const file = suiteSummaryPath(
      directory,
      'trinity-e2e-browser',
      'run-12345678',
      'browser.canonical',
    );
    const summary = {
      schemaVersion: 1,
      suiteId: 'browser.canonical',
      status: 'passed',
      attempts: 3,
      retries: 1,
      durationMs: 500,
      attemptDurationMs: 450,
      attemptsByStatus: { failed: 1, passed: 2 },
    } as const;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(summary)}\n`);

    expect(readPlaywrightSuiteSummary(file)).toEqual(summary);
  });

  it('rejects malformed or negative suite summaries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-suite-report-'));
    directories.push(directory);
    const file = join(directory, 'suite-summary.json');
    writeFileSync(
      file,
      `${JSON.stringify({
        schemaVersion: 1,
        suiteId: 'browser.canonical',
        status: 'unknown',
        attempts: -1,
        retries: 0,
        durationMs: 1,
        attemptDurationMs: 1,
        attemptsByStatus: {},
      })}\n`,
    );

    expect(() => readPlaywrightSuiteSummary(file)).toThrow(
      'Invalid Playwright suite summary',
    );
  });

  it.each([
    ['negative', { failed: -1 }],
    ['non-number', { failed: '1' }],
  ])('rejects %s attempt status counts', (_name, attemptsByStatus) => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-suite-report-'));
    directories.push(directory);
    const file = join(directory, 'suite-summary.json');
    writeFileSync(
      file,
      `${JSON.stringify({
        schemaVersion: 1,
        suiteId: 'browser.canonical',
        status: 'failed',
        attempts: 1,
        retries: 0,
        durationMs: 1,
        attemptDurationMs: 1,
        attemptsByStatus,
      })}\n`,
    );

    expect(() => readPlaywrightSuiteSummary(file)).toThrow(
      'Invalid Playwright suite summary',
    );
  });

  it.each(['durationMs', 'attemptDurationMs'] as const)(
    'rejects a non-finite %s',
    (field) => {
      const directory = mkdtempSync(join(tmpdir(), 'trinity-suite-report-'));
      directories.push(directory);
      const file = join(directory, 'suite-summary.json');
      const encoded = JSON.stringify({
        schemaVersion: 1,
        suiteId: 'browser.canonical',
        status: 'passed',
        attempts: 1,
        retries: 0,
        durationMs: 1,
        attemptDurationMs: 1,
        attemptsByStatus: { passed: 1 },
      }).replace(`"${field}":1`, `"${field}":1e400`);
      writeFileSync(file, `${encoded}\n`);

      expect(() => readPlaywrightSuiteSummary(file)).toThrow(
        'Invalid Playwright suite summary',
      );
    },
  );
});
