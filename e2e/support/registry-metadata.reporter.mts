import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface RegistryMetadataReporterOptions {
  readonly metadata: Readonly<Record<string, string>>;
  readonly outputFile?: string;
}

interface AnnotationTarget {
  readonly annotations: Array<{ type: string; description?: string }>;
}

/** Copy registry metadata onto every test so blob and JUnit preserve the same identity. */
export default class RegistryMetadataReporter implements Reporter {
  private readonly tests = new Map<string, TestCase>();
  private attempts = 0;
  private attemptDurationMs = 0;
  private readonly attemptsByStatus = new Map<string, number>();
  private readonly retriesByTest = new Map<string, number>();

  constructor(private readonly options: RegistryMetadataReporterOptions) {}

  printsToStdio(): boolean {
    return false;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    for (const test of suite.allTests()) {
      this.annotate(test);
      this.tests.set(test.id, test);
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // The worker replaces annotations added during onBegin with its own result.
    // Restore registry identity after that replacement, before blob and JUnit
    // serialize the completed test.
    this.annotate(result);
    this.annotate(test);
    this.attempts += 1;
    this.attemptDurationMs += result.duration;
    this.attemptsByStatus.set(
      result.status,
      (this.attemptsByStatus.get(result.status) ?? 0) + 1,
    );
    this.retriesByTest.set(
      test.id,
      Math.max(this.retriesByTest.get(test.id) ?? 0, result.retry),
    );
  }

  onEnd(result: FullResult): void {
    const tests = [...this.tests.values()];
    const outcomes = tests.map((test) => test.outcome());
    const selectedTestCount = tests.length;
    const skippedTestCount = outcomes.filter(
      (outcome) => outcome === 'skipped',
    ).length;
    const executedTestCount = selectedTestCount - skippedTestCount;
    const flakyTestCount = outcomes.filter(
      (outcome) => outcome === 'flaky',
    ).length;
    const expectedFailureCount = tests.filter(
      (test) =>
        test.expectedStatus === 'failed' && test.outcome() === 'expected',
    ).length;
    const unexpectedFailureCount = outcomes.filter(
      (outcome) => outcome === 'unexpected',
    ).length;
    const summary = {
      schemaVersion: 1,
      suiteId: this.options.metadata['trinity.e2e.suite'],
      status: result.status,
      attempts: this.attempts,
      retries: [...this.retriesByTest.values()].reduce(
        (total, retries) => total + retries,
        0,
      ),
      durationMs: result.duration,
      attemptDurationMs: this.attemptDurationMs,
      attemptsByStatus: Object.fromEntries(this.attemptsByStatus),
      selectedTestCount,
      executedTestCount,
      flakyTestCount,
      expectedFailureCount,
      unexpectedFailureCount,
      skippedTestCount,
    } as const;
    if (this.options.outputFile) {
      mkdirSync(dirname(this.options.outputFile), { recursive: true });
      writeFileSync(
        this.options.outputFile,
        `${JSON.stringify(summary, undefined, 2)}\n`,
      );
    }
    this.appendStepSummary(summary);
  }

  private appendStepSummary(summary: {
    readonly suiteId: string;
    readonly status: FullResult['status'];
    readonly selectedTestCount: number;
    readonly executedTestCount: number;
    readonly flakyTestCount: number;
    readonly expectedFailureCount: number;
    readonly unexpectedFailureCount: number;
    readonly skippedTestCount: number;
    readonly attempts: number;
    readonly retries: number;
    readonly durationMs: number;
  }): void {
    const file = process.env['GITHUB_STEP_SUMMARY'];
    if (!file) return;
    try {
      appendFileSync(
        file,
        [
          `### E2E suite ${summary.suiteId}`,
          '',
          '| Status | Selected | Executed | Flaky | Expected failures | Unexpected failures | Skipped | Attempts | Retries | Elapsed |',
          '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
          `| ${summary.status} | ${summary.selectedTestCount} | ${summary.executedTestCount} | ${summary.flakyTestCount} | ${summary.expectedFailureCount} | ${summary.unexpectedFailureCount} | ${summary.skippedTestCount} | ${summary.attempts} | ${summary.retries} | ${summary.durationMs} ms |`,
          '',
        ].join('\n'),
      );
    } catch (error) {
      process.stderr.write(
        `[e2e] unable to append suite summary: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  private annotate(target: AnnotationTarget): void {
    const existing = new Set(target.annotations.map(({ type }) => type));
    target.annotations.push(
      ...Object.entries(this.options.metadata)
        .filter(([type]) => !existing.has(type))
        .map(([type, description]) => ({ type, description })),
    );
  }
}
