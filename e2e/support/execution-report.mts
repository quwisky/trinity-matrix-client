import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  E2ECapability,
  E2ECiTier,
  E2EContractType,
  E2EEnvironment,
} from './e2e-registry.types.mts';
import { assertE2EArtifactPathSegment } from './artifact-path.mts';

export const E2E_OUTCOMES = [
  'pass',
  'failure',
  'retry',
  'quarantine',
  'unavailable',
  'skipped-by-tier',
  'not-run',
] as const;

export type E2EOutcome = (typeof E2E_OUTCOMES)[number];

export const PLAYWRIGHT_SUITE_STATUSES = [
  'passed',
  'failed',
  'timedout',
  'interrupted',
] as const;

export type PlaywrightSuiteStatus = (typeof PLAYWRIGHT_SUITE_STATUSES)[number];

export interface E2ESuiteSummary {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly status: PlaywrightSuiteStatus;
  readonly attempts: number;
  readonly retries: number;
  readonly durationMs: number;
  readonly attemptDurationMs: number;
  readonly attemptsByStatus: Readonly<Record<string, number>>;
}

/** @deprecated Use E2ESuiteSummary. Kept for Playwright callers during migration. */
export type PlaywrightSuiteSummary = E2ESuiteSummary;

export interface E2EAggregateSuiteResult {
  readonly id: string;
  readonly environment: E2EEnvironment;
  readonly capabilities: readonly E2ECapability[];
  readonly contractTypes: readonly E2EContractType[];
  readonly ciTier: E2ECiTier;
  readonly outcome: E2EOutcome;
  readonly retries: number;
  readonly durationMs: number;
  readonly detail?: string;
}

interface E2EOutcomeSummary {
  readonly suites: number;
  readonly retries: number;
  readonly durationMs: number;
  readonly outcomes: Readonly<Record<E2EOutcome, number>>;
}

export interface E2EAggregateReport {
  readonly schemaVersion: 1;
  readonly target: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly totals: E2EOutcomeSummary;
  readonly byEnvironment: Readonly<Record<string, E2EOutcomeSummary>>;
  readonly byCapability: Readonly<Record<string, E2EOutcomeSummary>>;
  readonly byContractType: Readonly<Record<string, E2EOutcomeSummary>>;
  readonly suites: readonly E2EAggregateSuiteResult[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPlaywrightSuiteStatus(
  value: unknown,
): value is PlaywrightSuiteStatus {
  return PLAYWRIGHT_SUITE_STATUSES.some((status) => status === value);
}

function isAttemptStatusCounts(
  value: unknown,
): value is Readonly<Record<string, number>> {
  return isRecord(value) && Object.values(value).every(isNonNegativeInteger);
}

export function suiteSummaryPath(
  workspaceRoot: string,
  project: string,
  runId: string,
  suiteId: string,
): string {
  for (const [value, label] of [
    [project, 'project'],
    [runId, 'run'],
    [suiteId, 'suite'],
  ] as const) {
    assertE2EArtifactPathSegment(value, label);
  }
  return join(
    workspaceRoot,
    'dist/.playwright',
    project,
    runId,
    suiteId,
    'suite-summary.json',
  );
}

export function readSuiteSummary(file: string): E2ESuiteSummary | undefined {
  if (!existsSync(file)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !isRecord(parsed) ||
    parsed['schemaVersion'] !== 1 ||
    typeof parsed['suiteId'] !== 'string' ||
    !isPlaywrightSuiteStatus(parsed['status']) ||
    !isNonNegativeInteger(parsed['attempts']) ||
    !isNonNegativeInteger(parsed['retries']) ||
    !isNonNegativeNumber(parsed['durationMs']) ||
    !isNonNegativeNumber(parsed['attemptDurationMs']) ||
    !isAttemptStatusCounts(parsed['attemptsByStatus'])
  ) {
    throw new Error(`Invalid Playwright suite summary: ${file}`);
  }
  return {
    schemaVersion: 1,
    suiteId: parsed['suiteId'],
    status: parsed['status'],
    attempts: parsed['attempts'],
    retries: parsed['retries'],
    durationMs: parsed['durationMs'],
    attemptDurationMs: parsed['attemptDurationMs'],
    attemptsByStatus: parsed['attemptsByStatus'],
  };
}

/** @deprecated Use readSuiteSummary. */
export function readPlaywrightSuiteSummary(
  file: string,
): PlaywrightSuiteSummary | undefined {
  return readSuiteSummary(file);
}

function emptyOutcomeCounts(): Record<E2EOutcome, number> {
  return Object.fromEntries(
    E2E_OUTCOMES.map((outcome) => [outcome, 0]),
  ) as Record<E2EOutcome, number>;
}

function summarize(
  results: readonly E2EAggregateSuiteResult[],
): E2EOutcomeSummary {
  const outcomes = emptyOutcomeCounts();
  let retries = 0;
  let durationMs = 0;
  for (const result of results) {
    outcomes[result.outcome] += 1;
    retries += result.retries;
    durationMs += result.durationMs;
  }
  return { suites: results.length, retries, durationMs, outcomes };
}

function groupedSummary(
  results: readonly E2EAggregateSuiteResult[],
  keys: (result: E2EAggregateSuiteResult) => readonly string[],
): Record<string, E2EOutcomeSummary> {
  const groups = new Map<string, E2EAggregateSuiteResult[]>();
  for (const result of results) {
    for (const key of keys(result)) {
      const group = groups.get(key) ?? [];
      group.push(result);
      groups.set(key, group);
    }
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, group]) => [key, summarize(group)]),
  );
}

export function buildAggregateReport(options: {
  readonly target: string;
  readonly runId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly results: readonly E2EAggregateSuiteResult[];
}): E2EAggregateReport {
  const suites = [...options.results].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  return {
    schemaVersion: 1,
    target: options.target,
    runId: options.runId,
    startedAt: options.startedAt.toISOString(),
    finishedAt: options.finishedAt.toISOString(),
    durationMs: Math.max(
      0,
      options.finishedAt.getTime() - options.startedAt.getTime(),
    ),
    totals: summarize(suites),
    byEnvironment: groupedSummary(suites, ({ environment }) => [environment]),
    byCapability: groupedSummary(suites, ({ capabilities }) => capabilities),
    byContractType: groupedSummary(
      suites,
      ({ contractTypes }) => contractTypes,
    ),
    suites,
  };
}

function markdownReport(report: E2EAggregateReport): string {
  const summaryTable = (
    title: string,
    groups: Readonly<Record<string, E2EOutcomeSummary>>,
  ): string[] => [
    `## ${title}`,
    '',
    '| Group | Suites | Pass | Failure | Retry | Quarantine | Unavailable | Skipped by tier | Not run | Retries | Duration |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(groups).map(
      ([group, summary]) =>
        `| ${group} | ${summary.suites} | ${summary.outcomes.pass} | ${summary.outcomes.failure} | ${summary.outcomes.retry} | ${summary.outcomes.quarantine} | ${summary.outcomes.unavailable} | ${summary.outcomes['skipped-by-tier']} | ${summary.outcomes['not-run']} | ${summary.retries} | ${summary.durationMs} ms |`,
    ),
    '',
  ];
  const lines = [
    `# E2E aggregate ${report.target}`,
    '',
    `Run: \`${report.runId}\``,
    '',
    ...summaryTable('By environment', report.byEnvironment),
    ...summaryTable('By capability', report.byCapability),
    ...summaryTable('By contract type', report.byContractType),
    '## Suites',
    '',
    '| Suite | Environment | Tier | Outcome | Retries | Duration |',
    '| --- | --- | --- | --- | ---: | ---: |',
    ...report.suites.map(
      (suite) =>
        `| ${suite.id} | ${suite.environment} | ${suite.ciTier} | ${suite.outcome} | ${suite.retries} | ${suite.durationMs} ms |`,
    ),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function writeAggregateReport(
  workspaceRoot: string,
  report: E2EAggregateReport,
): { readonly json: string; readonly markdown: string } {
  assertE2EArtifactPathSegment(report.runId, 'run');
  assertE2EArtifactPathSegment(report.target, 'aggregate');
  const root = join(
    workspaceRoot,
    'dist/.playwright/trinity-e2e',
    report.runId,
    report.target,
  );
  const json = join(root, 'summary.json');
  const markdown = join(root, 'summary.md');
  mkdirSync(dirname(json), { recursive: true });
  writeFileSync(json, `${JSON.stringify(report, undefined, 2)}\n`);
  writeFileSync(markdown, markdownReport(report));
  return { json, markdown };
}
