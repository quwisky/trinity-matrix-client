import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
const reporter = join(import.meta.dirname, 'node-reporter.mts');

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function runNode(
  source: string,
  suiteId: string,
): { directory: string; status: number | null; signal: NodeJS.Signals | null } {
  const directory = mkdtempSync(join(tmpdir(), 'trinity-node-reporter-'));
  directories.push(directory);
  const file = join(directory, 'fixture.mjs');
  writeFileSync(file, source);
  const result = execFileSync(
    process.execPath,
    [
      '--test',
      '--test-reporter',
      reporter,
      '--test-reporter-destination',
      'stdout',
      file,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TRINITY_E2E_SUITE_ID: suiteId,
        TRINITY_E2E_REPORT_DIR: directory,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  expect(result).toBeTypeOf('string');
  return { directory, status: 0, signal: null };
}

function runNodeAllowFailure(source: string, suiteId: string) {
  const directory = mkdtempSync(join(tmpdir(), 'trinity-node-reporter-'));
  directories.push(directory);
  const file = join(directory, 'fixture.mjs');
  writeFileSync(file, source);
  const child = spawn(
    process.execPath,
    [
      '--test',
      '--test-reporter',
      reporter,
      '--test-reporter-destination',
      'stdout',
      file,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TRINITY_E2E_SUITE_ID: suiteId,
        TRINITY_E2E_REPORT_DIR: directory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return new Promise<{
    directory: string;
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
  }>((resolve) => {
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.resume();
    child.on('close', (status, signal) =>
      resolve({ directory, status, signal, stdout }),
    );
  });
}

describe('Node test reporter', () => {
  it('retains the deepest fixture cleanup cause in process diagnostics', async () => {
    const result = await runNodeAllowFailure(
      `import { test } from 'node:test';
       import { withNodeTestResources } from ${JSON.stringify(new URL('./node-fixtures.mts', import.meta.url).href)};
       test('cleanup fails', () => withNodeTestResources(
         { sessionId: 'diagnostics', testId: 'cleanup' },
         async ({ namespace }) => {
           namespace.registerCleanup('Android WebView diagnostics', async () => {
             throw new AggregateError([
               new Error('ADB forward removal deadline exceeded')
             ], 'WebView cleanup failed');
           });
           throw new Error('flow failed');
         }
       ));`,
      'node.cleanup-diagnostics',
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('ADB forward removal deadline exceeded');
    expect(
      readFileSync(join(result.directory, 'process.log'), 'utf8'),
    ).toContain('ADB forward removal deadline exceeded');
    expect(
      JSON.parse(
        readFileSync(join(result.directory, 'suite-summary.json'), 'utf8'),
      ),
    ).toMatchObject({ status: 'failed', attemptsByStatus: { failed: 1 } });
  });

  it('retains process diagnostics for a failure before any test can start', async () => {
    const result = await runNodeAllowFailure(
      "console.error('startup diagnostic marker'); throw new Error('deliberate startup detail');",
      'node.startup-diagnostics',
    );
    expect(result.status).not.toBe(0);
    const diagnostic = readFileSync(
      join(result.directory, 'process.log'),
      'utf8',
    );
    expect(diagnostic).toContain('startup diagnostic marker');
    expect(diagnostic).toContain('deliberate startup detail');
    expect(diagnostic).toContain('fixture.mjs');
  });

  it('writes a passed summary, progress JSONL and JUnit from a real child', () => {
    const result = runNode(
      "import { test } from 'node:test'; test('passes', () => {});",
      'node.pass',
    );
    expect(result.status).toBe(0);
    const summary = JSON.parse(
      readFileSync(join(result.directory, 'suite-summary.json'), 'utf8'),
    );
    expect(summary).toMatchObject({
      suiteId: 'node.pass',
      status: 'passed',
      attempts: 1,
      attemptsByStatus: { passed: 1 },
    });
    expect(
      readFileSync(join(result.directory, 'test-progress.jsonl'), 'utf8'),
    ).toContain('"event":"begin"');
    expect(
      readFileSync(join(result.directory, 'junit/results.xml'), 'utf8'),
    ).toContain('trinity.e2e.suite');
  });

  it('keeps a failed first attempt failed when the child exits red', async () => {
    const result = await runNodeAllowFailure(
      "import { test } from 'node:test'; test('fails', () => { throw new Error('no'); });",
      'node.fail',
    );
    expect(result.status).not.toBe(0);
    expect(
      JSON.parse(
        readFileSync(join(result.directory, 'suite-summary.json'), 'utf8'),
      ),
    ).toMatchObject({
      suiteId: 'node.fail',
      status: 'failed',
      attemptsByStatus: { failed: 1 },
    });
  });

  it('keeps Node rerun success non-green when the first attempt failed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-node-rerun-'));
    directories.push(directory);
    const file = join(directory, 'fixture.mjs');
    const state = join(directory, 'first-attempt');
    const rerunState = join(directory, 'rerun.json');
    writeFileSync(
      file,
      `import { test } from 'node:test'; import { existsSync, writeFileSync } from 'node:fs'; test('flaky', () => { if (!existsSync(${JSON.stringify(state)})) { writeFileSync(${JSON.stringify(state)}, 'x'); throw new Error('first'); } });\n`,
    );
    const args = [
      '--test',
      `--test-rerun-failures=${rerunState}`,
      '--test-reporter',
      reporter,
      '--test-reporter-destination',
      'stdout',
      file,
    ];
    const environment = {
      ...process.env,
      TRINITY_E2E_SUITE_ID: 'node.rerun',
      TRINITY_E2E_REPORT_DIR: directory,
    };
    expect(
      spawnSync(process.execPath, args, {
        cwd: process.cwd(),
        env: environment,
      }).status,
    ).not.toBe(0);
    expect(
      spawnSync(process.execPath, args, {
        cwd: process.cwd(),
        env: environment,
      }).status,
    ).toBe(0);
    expect(
      JSON.parse(readFileSync(join(directory, 'suite-summary.json'), 'utf8')),
    ).toMatchObject({
      suiteId: 'node.rerun',
      status: 'failed',
      attempts: 1,
      retries: 1,
      attemptsByStatus: { passed: 1 },
    });
  });

  it('writes a non-green summary for a discovered file with no executed tests', async () => {
    const result = await runNodeAllowFailure(
      "import { describe } from 'node:test'; describe('empty', () => {});",
      'node.empty',
    );
    expect(result.status).toBe(0);
    expect(
      JSON.parse(
        readFileSync(join(result.directory, 'suite-summary.json'), 'utf8'),
      ),
    ).toMatchObject({
      suiteId: 'node.empty',
      status: 'interrupted',
      attempts: 0,
    });
  });

  it('does not count skipped and TODO tests as executed attempts', async () => {
    const result = await runNodeAllowFailure(
      "import { test } from 'node:test'; test('skip', { skip: true }, () => {}); test('todo', { todo: true }, () => {});",
      'node.skip-only',
    );
    expect(result.status).toBe(0);
    expect(
      JSON.parse(
        readFileSync(join(result.directory, 'suite-summary.json'), 'utf8'),
      ),
    ).toMatchObject({
      suiteId: 'node.skip-only',
      status: 'interrupted',
      attempts: 0,
      attemptsByStatus: {},
    });
  });

  it('reports only the leaf attempt for nested suites', () => {
    const result = runNode(
      "import { describe, test } from 'node:test'; describe('outer', () => describe('inner', () => test('leaf', () => {})));",
      'node.nested',
    );
    const entries = readFileSync(
      join(result.directory, 'test-progress.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries.filter((entry) => entry.event === 'begin')).toHaveLength(1);
    expect(
      JSON.parse(
        readFileSync(join(result.directory, 'suite-summary.json'), 'utf8'),
      ),
    ).toMatchObject({
      suiteId: 'node.nested',
      status: 'passed',
      attempts: 1,
    });
  });

  it('does not leave a green artifact when interrupted before completion', async () => {
    const resultPromise = runNodeAllowFailure(
      "import { test } from 'node:test'; setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100); test('hangs', async () => { await new Promise(() => {}); });",
      'node.interrupt',
    );
    const childResult = await Promise.race([
      resultPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('child did not finish')), 5_000),
      ),
    ]);
    expect(childResult.status).not.toBe(0);
    const summaryFile = join(childResult.directory, 'suite-summary.json');
    expect(
      !existsSync(summaryFile) ||
        JSON.parse(readFileSync(summaryFile, 'utf8')).status,
    ).not.toBe('passed');
  });
});
