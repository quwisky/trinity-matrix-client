import { Transform, type TransformCallback } from 'node:stream';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { EventData } from 'node:test';
import type { TestEvent } from 'node:test/reporters';
import { inspect } from 'node:util';

/** Environment variables consumed by the Node test reporter. */
export const NODE_REPORTER_SUITE_ENV = 'TRINITY_E2E_SUITE_ID';
export const NODE_REPORTER_DIRECTORY_ENV = 'TRINITY_E2E_REPORT_DIR';

type Attempt = {
  readonly name: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly durationMs: number;
  readonly status: 'passed' | 'failed';
  readonly attempt: number;
  readonly error?: string;
};

const xml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/>/g, '&gt;');

/**
 * Node's built-in test runner reporter for Trinity suite artifacts.
 *
 * Configure the exact suite artifact directory with TRINITY_E2E_REPORT_DIR.
 * The reporter deliberately has no Playwright dependency and can be loaded by
 * `node --test --test-reporter ./node-reporter.mts`.
 */
export default class NodeReporter extends Transform {
  private readonly suiteId = process.env[NODE_REPORTER_SUITE_ENV] ?? '';
  private readonly directory = process.env[NODE_REPORTER_DIRECTORY_ENV];
  private readonly attempts: Attempt[] = [];
  private readonly started = new Map<string, EventData.TestStart>();
  private readonly progressStarted = new Set<string>();
  private summary: EventData.TestSummary | undefined;
  private sawFailure = false;
  private sawEvent = false;
  private flushed = false;
  private progressInitialized = false;

  constructor() {
    super({ writableObjectMode: true });
  }

  override _transform(
    chunk: TestEvent,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.sawEvent = true;
    switch (chunk.type) {
      case 'test:stdout':
      case 'test:stderr':
        this.push(chunk.data.message);
        if (this.directory) {
          mkdirSync(this.directory, { recursive: true });
          appendFileSync(
            join(this.directory, 'process.log'),
            chunk.data.message,
          );
        }
        break;
      case 'test:start':
        this.started.set(this.eventKey(chunk.data), chunk.data);
        break;
      case 'test:pass':
        if (
          (chunk.data.details.passed_on_attempt !== undefined &&
            chunk.data.details.passed_on_attempt > 0) ||
          (chunk.data.details.attempt !== undefined &&
            chunk.data.details.attempt > 0)
        ) {
          // Node's rerun mode only emits the successful attempt in the second
          // process. Preserve the first-attempt failure in the suite outcome.
          this.sawFailure = true;
        }
        if (
          chunk.data.details.type !== 'suite' &&
          !chunk.data.skip &&
          !chunk.data.todo
        )
          this.record('passed', chunk.data);
        break;
      case 'test:fail':
        this.sawFailure = true;
        this.push(
          `${chunk.data.name}: ${inspect(chunk.data.details.error, { depth: 5, colors: false })}\n`,
        );
        if (chunk.data.details.type !== 'suite')
          this.record('failed', chunk.data);
        break;
      case 'test:summary':
        this.summary = chunk.data;
        break;
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.finalize();
    callback();
  }

  private record(
    status: Attempt['status'],
    data: EventData.TestPass | EventData.TestFail,
  ): void {
    const attempt = data.details.attempt ?? (status === 'failed' ? 0 : 0);
    const start = this.started.get(this.eventKey(data));
    this.writeBegin(data, start);
    const item: Attempt = {
      name: data.name,
      file: data.file ?? start?.file,
      line: data.line ?? start?.line,
      column: data.column ?? start?.column,
      durationMs: data.details.duration_ms,
      status,
      attempt,
      ...(status === 'failed'
        ? {
            error: inspect(
              (data.details as EventData.TestFail['details']).error,
              { depth: 5, colors: false },
            ),
          }
        : {}),
    };
    this.attempts.push(item);
    this.writeProgress({
      event: 'end',
      name: item.name,
      file: item.file,
      line: item.line,
      column: item.column,
      durationMs: item.durationMs,
      status,
      attempt,
    });
  }

  private eventKey(data: {
    readonly name: string;
    readonly file?: string;
    readonly line?: number;
    readonly column?: number;
  }): string {
    return `${data.file ?? ''}:${data.line ?? ''}:${data.column ?? ''}:${data.name}`;
  }

  private writeBegin(
    data: EventData.TestPass | EventData.TestFail,
    start: EventData.TestStart | undefined,
  ): void {
    const key = this.eventKey(data);
    if (this.progressStarted.has(key)) return;
    this.progressStarted.add(key);
    this.writeProgress({
      event: 'begin',
      name: data.name,
      file: data.file ?? start?.file,
      line: data.line ?? start?.line,
      column: data.column ?? start?.column,
    });
  }

  private writeProgress(entry: Record<string, unknown>): void {
    if (!this.directory) return;
    const file = join(this.directory, 'test-progress.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    if (!this.progressInitialized) {
      writeFileSync(file, '');
      this.progressInitialized = true;
    }
    appendFileSync(
      file,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        testId: `${String(entry['file'] ?? '')}:${String(entry['line'] ?? '')}:${String(entry['name'] ?? '')}`,
        title: entry['name'],
        retry: entry['attempt'] ?? 0,
        ...entry,
      })}\n`,
    );
  }

  private finalize(): void {
    if (this.flushed || !this.directory) return;
    this.flushed = true;
    mkdirSync(this.directory, { recursive: true });
    mkdirSync(join(this.directory, 'junit'), { recursive: true });
    if (!this.progressInitialized) {
      writeFileSync(join(this.directory, 'test-progress.jsonl'), '');
      this.progressInitialized = true;
    }
    const durationMs =
      this.summary?.duration_ms ??
      this.attempts.reduce((sum, item) => sum + item.durationMs, 0);
    const status = this.sawFailure
      ? 'failed'
      : this.summary?.success && this.attempts.length > 0
        ? 'passed'
        : this.sawEvent
          ? 'interrupted'
          : 'interrupted';
    const retriesByTest = new Map<string, number>();
    for (const attempt of this.attempts)
      retriesByTest.set(
        attempt.name,
        Math.max(retriesByTest.get(attempt.name) ?? 0, attempt.attempt),
      );
    const attemptsByStatus: Record<string, number> = {};
    for (const attempt of this.attempts)
      attemptsByStatus[attempt.status] =
        (attemptsByStatus[attempt.status] ?? 0) + 1;
    const summary = {
      schemaVersion: 1 as const,
      suiteId: this.suiteId,
      status,
      attempts: this.attempts.length,
      retries: [...retriesByTest.values()].reduce(
        (sum, value) => sum + value,
        0,
      ),
      durationMs: Math.max(0, durationMs),
      attemptDurationMs: this.attempts.reduce(
        (sum, item) => sum + item.durationMs,
        0,
      ),
      attemptsByStatus,
    };
    writeFileSync(
      join(this.directory, 'suite-summary.json'),
      `${JSON.stringify(summary, undefined, 2)}\n`,
    );
    writeFileSync(
      join(this.directory, 'junit', 'results.xml'),
      this.junit(status, durationMs),
    );
  }

  private junit(status: string, durationMs: number): string {
    const failures = this.attempts.filter(
      (attempt) => attempt.status === 'failed',
    );
    const cases = this.attempts
      .map((attempt) => {
        const location = attempt.file
          ? ` file="${xml(relative(process.cwd(), attempt.file))}"`
          : '';
        const failure =
          attempt.status === 'failed'
            ? `<failure message="${xml(attempt.error ?? 'failed')}"/>`
            : '';
        return `    <testcase name="${xml(attempt.name)}" time="${(attempt.durationMs / 1000).toFixed(3)}"${location}>${failure}</testcase>`;
      })
      .join('\n');
    const properties = `    <properties><property name="trinity.e2e.suite" value="${xml(this.suiteId)}"/></properties>`;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${this.attempts.length}" failures="${failures.length}" time="${(durationMs / 1000).toFixed(3)}" status="${status}">\n  <testsuite name="${xml(this.suiteId)}" tests="${this.attempts.length}" failures="${failures.length}">\n${properties}${cases ? `\n${cases}` : ''}\n  </testsuite>\n</testsuites>\n`;
  }
}
