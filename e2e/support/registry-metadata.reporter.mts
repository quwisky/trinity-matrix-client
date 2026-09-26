import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';

interface RegistryMetadataReporterOptions {
  readonly metadata: Readonly<Record<string, string>>;
  readonly outputFile?: string;
  readonly progressFile?: string;
}

interface AnnotationTarget {
  readonly annotations: Array<{ type: string; description?: string }>;
}

/** Copy registry metadata onto every test so blob and JUnit preserve the same identity. */
export default class RegistryMetadataReporter implements Reporter {
  private attempts = 0;
  private attemptDurationMs = 0;
  private readonly attemptsByStatus = new Map<string, number>();
  private readonly retriesByTest = new Map<string, number>();
  private progressInitialized = false;

  constructor(private readonly options: RegistryMetadataReporterOptions) {}

  printsToStdio(): boolean {
    return false;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.initializeProgress();
    for (const test of suite.allTests()) {
      this.annotate(test);
    }
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    this.writeProgress('begin', test, result);
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
    this.writeProgress('end', test, result);
  }

  onEnd(result: FullResult): void {
    if (!this.options.outputFile) return;
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
    } as const;
    mkdirSync(dirname(this.options.outputFile), { recursive: true });
    writeFileSync(
      this.options.outputFile,
      `${JSON.stringify(summary, undefined, 2)}\n`,
    );
  }

  private annotate(target: AnnotationTarget): void {
    const existing = new Set(target.annotations.map(({ type }) => type));
    target.annotations.push(
      ...Object.entries(this.options.metadata)
        .filter(([type]) => !existing.has(type))
        .map(([type, description]) => ({ type, description })),
    );
  }

  private initializeProgress(): void {
    if (this.progressInitialized || !this.options.progressFile) return;
    mkdirSync(dirname(this.options.progressFile), { recursive: true });
    writeFileSync(this.options.progressFile, '');
    this.progressInitialized = true;
  }

  private writeProgress(
    event: 'begin' | 'end',
    test: TestCase,
    result: TestResult,
  ): void {
    if (!this.options.progressFile || !this.progressInitialized) return;
    const location = test.location
      ? relative(process.cwd(), test.location.file)
      : undefined;
    const entry = {
      event,
      timestamp: new Date().toISOString(),
      testId: test.id,
      title: test.titlePath().join(' > '),
      project: test.parent.project()?.name,
      ...(location ? { location } : {}),
      retry: result.retry,
      workerIndex: result.workerIndex,
      ...(event === 'end'
        ? { durationMs: result.duration, status: result.status }
        : {}),
    };
    appendFileSync(this.options.progressFile, `${JSON.stringify(entry)}\n`);
  }
}
