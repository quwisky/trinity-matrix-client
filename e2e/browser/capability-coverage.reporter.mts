import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import {
  BROWSER_JOURNEYS,
  BROWSER_JOURNEY_BY_PATH,
  type BrowserJourneyPath,
} from './journey-catalog.mts';

interface CapabilityCoverageReporterOptions {
  readonly outputFile: string;
}

interface AnnotationTarget {
  readonly annotations: Array<{ type: string; description?: string }>;
}

interface TestCoverage {
  readonly capability: string;
  readonly contractType: string;
  readonly path: BrowserJourneyPath;
  readonly title: string;
  readonly project: string;
  status: TestResult['status'];
  attempts: number;
  retries: number;
  durationMs: number;
}

interface CoverageGroup {
  specCount: number;
  testCount: number;
  attempts: number;
  retries: number;
  durationMs: number;
  statuses: Record<string, number>;
}

const normalizedPath = (value: string): string => value.replaceAll('\\', '/');

/** Resolve a Playwright location to the catalog path relative to e2e/browser. */
export function browserJourneyPath(file: string): BrowserJourneyPath {
  const normalized = normalizedPath(file);
  const rootedMarker = '/e2e/browser/';
  const markerAt = normalized.lastIndexOf(rootedMarker);
  const candidate =
    markerAt >= 0
      ? normalized.slice(markerAt + rootedMarker.length)
      : normalized.startsWith('e2e/browser/')
        ? normalized.slice('e2e/browser/'.length)
        : normalized.startsWith('journeys/')
          ? normalized
          : normalizedPath(
              relative(
                import.meta.dirname,
                isAbsolute(file) ? file : resolve(file),
              ),
            );
  if (!BROWSER_JOURNEY_BY_PATH.has(candidate as BrowserJourneyPath)) {
    throw new Error(`Unclassified canonical browser journey: ${file}`);
  }
  return candidate as BrowserJourneyPath;
}

const annotation = (type: string, description: string) => ({
  type,
  description,
});

const annotate = (
  target: AnnotationTarget,
  capability: string,
  contractType: string,
): void => {
  const expected = new Map([
    ['trinity.e2e.capability', capability],
    ['trinity.e2e.contractType', contractType],
  ]);
  for (const [type, description] of expected) {
    const matches = target.annotations.filter(
      (candidate) => candidate.type === type,
    );
    if (matches.length > 1) {
      throw new Error(`Duplicate ${type} annotation`);
    }
    if (matches[0] && matches[0].description !== description) {
      throw new Error(
        `${type} annotation is ${matches[0].description}, expected ${description}`,
      );
    }
    if (matches.length === 0) {
      target.annotations.push(annotation(type, description));
    }
  }
};

const emptyGroup = (): CoverageGroup => ({
  specCount: 0,
  testCount: 0,
  attempts: 0,
  retries: 0,
  durationMs: 0,
  statuses: {},
});

const groupedCoverage = (
  tests: readonly TestCoverage[],
  dimension: 'capability' | 'contractType',
): Record<string, CoverageGroup> => {
  const groups: Record<string, CoverageGroup> = {};
  const specPaths = new Map<string, Set<string>>();
  for (const test of tests) {
    const key = test[dimension];
    const group = (groups[key] ??= emptyGroup());
    const paths = specPaths.get(key) ?? new Set();
    paths.add(test.path);
    specPaths.set(key, paths);
    group.testCount += 1;
    group.attempts += test.attempts;
    group.retries += test.retries;
    group.durationMs += test.durationMs;
    group.statuses[test.status] = (group.statuses[test.status] ?? 0) + 1;
  }
  for (const [key, paths] of specPaths) groups[key].specCount = paths.size;
  return Object.fromEntries(
    Object.entries(groups).sort(([left], [right]) => left.localeCompare(right)),
  );
};

/** Emit executable coverage grouped by the same capability/contract catalog. */
export default class CapabilityCoverageReporter implements Reporter {
  private readonly tests = new Map<string, TestCoverage>();

  constructor(private readonly options: CapabilityCoverageReporterOptions) {}

  printsToStdio(): boolean {
    return false;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    for (const test of suite.allTests()) {
      const path = browserJourneyPath(test.location.file);
      const journey = BROWSER_JOURNEY_BY_PATH.get(path);
      if (!journey)
        throw new Error(`Missing browser journey catalog entry: ${path}`);
      annotate(test, journey.capability, journey.contractType);
      this.tests.set(test.id, {
        capability: journey.capability,
        contractType: journey.contractType,
        path,
        title: test.titlePath().join(' > '),
        project: test.parent.project()?.name ?? 'unknown',
        status: 'skipped',
        attempts: 0,
        retries: 0,
        durationMs: 0,
      });
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const coverage = this.tests.get(test.id);
    if (!coverage) {
      throw new Error(`Browser coverage did not collect test ${test.id}`);
    }
    annotate(test, coverage.capability, coverage.contractType);
    annotate(result, coverage.capability, coverage.contractType);
    coverage.status = result.status;
    coverage.attempts += 1;
    coverage.retries = Math.max(coverage.retries, result.retry);
    coverage.durationMs += result.duration;
  }

  async onEnd(result: FullResult): Promise<void> {
    const tests = [...this.tests.values()].sort((left, right) =>
      `${left.path}\0${left.project}\0${left.title}`.localeCompare(
        `${right.path}\0${right.project}\0${right.title}`,
      ),
    );
    const collectedSpecs = new Set(tests.map(({ path }) => path));
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runStatus: result.status,
      expectedSpecCount: BROWSER_JOURNEYS.length,
      collectedSpecCount: collectedSpecs.size,
      testCount: tests.length,
      attempts: tests.reduce((sum, test) => sum + test.attempts, 0),
      retries: tests.reduce((sum, test) => sum + test.retries, 0),
      durationMs: tests.reduce((sum, test) => sum + test.durationMs, 0),
      byCapability: groupedCoverage(tests, 'capability'),
      byContractType: groupedCoverage(tests, 'contractType'),
      tests,
    };
    await mkdir(dirname(this.options.outputFile), { recursive: true });
    await writeFile(
      this.options.outputFile,
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
  }
}
