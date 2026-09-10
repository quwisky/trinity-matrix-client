import { describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareWebBundle, runPlaywright } from './run-playwright.mts';
import { runNode } from './run-node.mts';
import { recoverResourceLock, resourceLockFile } from './recover-lock.mts';
import { synapseLockFile } from './synapse/lease.mts';

describe('E2E runner boundaries', () => {
  it('rejects malformed runner arguments before acquiring resources', async () => {
    await expect(runPlaywright([])).rejects.toThrow(/requires --config/);
  });

  it('rejects malformed Node runner arguments before acquiring resources', async () => {
    await expect(runNode([])).rejects.toThrow(/requires --suite/);
  });

  it('wires the owned reporter, serial execution, report directory and IDs', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'trinity-node-runner-'));
    const close = vi.fn(async () => undefined);
    const execute = vi.fn(async (_command, _args, options) => {
      mkdirSync(
        options.environment?.['TRINITY_E2E_REPORT_DIR'] ?? workspaceRoot,
        {
          recursive: true,
        },
      );
      writeFileSync(
        join(
          options.environment?.['TRINITY_E2E_REPORT_DIR'] ?? workspaceRoot,
          'suite-summary.json',
        ),
        JSON.stringify({
          schemaVersion: 1,
          suiteId: 'node.integration',
          status: 'passed',
          attempts: 1,
          retries: 0,
          durationMs: 1,
          attemptDurationMs: 1,
          attemptsByStatus: { passed: 1 },
        }),
      );
      return { status: 0, timedOut: false };
    });
    try {
      await expect(
        runNode(
          [
            '--suite=node.integration',
            '--entrypoint=e2e/node.spec.mts',
            '--resource=synapse',
            '--platform=android',
            '--test-name-pattern=smoke',
          ],
          { TRINITY_E2E_PROJECT: 'node-project' },
          {
            workspaceRoot,
            openInvocation: async (options) => ({
              owned: true,
              file: 'session.json',
              descriptor: {
                version: 1,
                id: 'run-node-1234',
                workspaceRoot,
                owner: {
                  pid: process.pid,
                  nonce: 'nonce-node-1234',
                  createdAt: new Date().toISOString(),
                },
                resources: options?.resources ?? [],
                endpoints: {
                  application: 'http://127.0.0.1:10001/',
                  storybook: 'http://127.0.0.1:10002/',
                  report: 'http://127.0.0.1:10003/',
                },
                artifactsRoot: join(workspaceRoot, 'artifacts'),
              },
              environment: {},
              close,
            }),
            prepareBundle: vi.fn().mockResolvedValue(0),
            executeCommand: execute,
          },
        ),
      ).resolves.toBe(0);
      expect(execute).toHaveBeenCalledWith(
        process.execPath,
        [
          '--test',
          '--test-concurrency=1',
          '--test-reporter',
          join(workspaceRoot, 'e2e/support/node-reporter.mts'),
          '--test-reporter-destination',
          'stdout',
          '--test-name-pattern=smoke',
          'e2e/node.spec.mts',
        ],
        expect.objectContaining({
          cwd: workspaceRoot,
          terminationGraceMs: 10_000,
          cleanupProcessGroup: true,
          environment: expect.objectContaining({
            TRINITY_E2E_SUITE_ID: 'node.integration',
            TRINITY_E2E_PROJECT: 'node-project',
            TRINITY_E2E_RUN_ID: 'run-node-1234',
            TRINITY_E2E_PLATFORM: 'android',
            TRINITY_E2E_REPORT_DIR: join(
              workspaceRoot,
              'dist/.playwright/node-project/run-node-1234/node.integration',
            ),
          }),
        }),
      );
      expect(close).toHaveBeenCalledOnce();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('writes a failed terminal summary when bundle startup fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'trinity-node-runner-'));
    try {
      const result = await runNode(
        ['--suite=node.startup', '--entrypoint=e2e/node.spec.mts'],
        {},
        {
          workspaceRoot,
          openInvocation: async () => ({
            owned: true,
            file: 'session.json',
            descriptor: {
              version: 1,
              id: 'run-node-start',
              workspaceRoot,
              owner: {
                pid: process.pid,
                nonce: 'nonce-node-start',
                createdAt: new Date().toISOString(),
              },
              resources: [],
              endpoints: {
                application: 'http://127.0.0.1:10001/',
                storybook: 'http://127.0.0.1:10002/',
                report: 'http://127.0.0.1:10003/',
              },
              artifactsRoot: join(workspaceRoot, 'artifacts'),
            },
            environment: {},
            close: async () => undefined,
          }),
          prepareBundle: vi.fn().mockResolvedValue(7),
        },
      );
      expect(result).toBe(7);
      expect(
        JSON.parse(
          readFileSync(
            join(
              workspaceRoot,
              'dist/.playwright/trinity-e2e-node/run-node-start/node.startup/suite-summary.json',
            ),
            'utf8',
          ),
        ),
      ).toMatchObject({ suiteId: 'node.startup', status: 'failed' });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects an exit-zero child that emits no terminal summary', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'trinity-node-runner-'));
    try {
      const result = await runNode(
        ['--suite=node.missing', '--entrypoint=e2e/node.spec.mts'],
        {},
        {
          workspaceRoot,
          openInvocation: async () => ({
            owned: true,
            file: 'session.json',
            descriptor: {
              version: 1,
              id: 'run-node-missing',
              workspaceRoot,
              owner: {
                pid: process.pid,
                nonce: 'nonce-node-missing',
                createdAt: new Date().toISOString(),
              },
              resources: [],
              endpoints: {
                application: 'http://127.0.0.1:10001/',
                storybook: 'http://127.0.0.1:10002/',
                report: 'http://127.0.0.1:10003/',
              },
              artifactsRoot: join(workspaceRoot, 'artifacts'),
            },
            environment: {},
            close: async () => undefined,
          }),
          prepareBundle: vi.fn().mockResolvedValue(0),
          executeCommand: vi.fn().mockResolvedValue({
            status: 0,
            timedOut: false,
          }),
        },
      );
      expect(result).toBe(1);
      expect(
        JSON.parse(
          readFileSync(
            join(
              workspaceRoot,
              'dist/.playwright/trinity-e2e-node/run-node-missing/node.missing/suite-summary.json',
            ),
            'utf8',
          ),
        ),
      ).toMatchObject({ suiteId: 'node.missing', status: 'failed' });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('runs a real Node child through the custom reporter', async () => {
    const workspaceRoot = resolve(import.meta.dirname, '../..');
    const sourceRoot = mkdtempSync(join(tmpdir(), 'trinity-node-entrypoint-'));
    const entrypoint = join(sourceRoot, 'runner.mts');
    const reportRoot = join(workspaceRoot, 'dist/.playwright/node-runner-real');
    writeFileSync(
      entrypoint,
      "import { test } from 'node:test'; test('real reporter wiring', () => {});\n",
    );
    try {
      const result = await runNode(
        ['--suite=runner.real', `--entrypoint=${entrypoint}`],
        { TRINITY_E2E_PROJECT: 'node-runner-real' },
        {
          workspaceRoot,
          openInvocation: async () => ({
            owned: true,
            file: 'session.json',
            descriptor: {
              version: 1,
              id: 'run-node-real',
              workspaceRoot,
              owner: {
                pid: process.pid,
                nonce: 'nonce-node-real',
                createdAt: new Date().toISOString(),
              },
              resources: [],
              endpoints: {
                application: 'http://127.0.0.1:10001/',
                storybook: 'http://127.0.0.1:10002/',
                report: 'http://127.0.0.1:10003/',
              },
              artifactsRoot: join(workspaceRoot, 'artifacts'),
            },
            environment: {},
            close: async () => undefined,
          }),
          prepareBundle: vi.fn().mockResolvedValue(0),
        },
      );
      expect(result).toBe(0);
      expect(
        JSON.parse(
          readFileSync(
            join(reportRoot, 'run-node-real/runner.real/suite-summary.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({ suiteId: 'runner.real', status: 'passed' });
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(reportRoot, { recursive: true, force: true });
    }
  });

  it('preserves child failure and marks the summary when teardown fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'trinity-node-runner-'));
    try {
      const closeError = new Error('resource cleanup failed');
      let failure: unknown;
      try {
        await runNode(
          ['--suite=node.cleanup', '--entrypoint=e2e/node.spec.mts'],
          {},
          {
            workspaceRoot,
            openInvocation: async () => ({
              owned: true,
              file: 'session.json',
              descriptor: {
                version: 1,
                id: 'run-node-clean',
                workspaceRoot,
                owner: {
                  pid: process.pid,
                  nonce: 'nonce-node-clean',
                  createdAt: new Date().toISOString(),
                },
                resources: [],
                endpoints: {
                  application: 'http://127.0.0.1:10001/',
                  storybook: 'http://127.0.0.1:10002/',
                  report: 'http://127.0.0.1:10003/',
                },
                artifactsRoot: join(workspaceRoot, 'artifacts'),
              },
              environment: {},
              close: async () => {
                throw closeError;
              },
            }),
            prepareBundle: vi.fn().mockResolvedValue(0),
            executeCommand: vi.fn(async (_command, _args, options) => {
              const directory = options.environment?.['TRINITY_E2E_REPORT_DIR'];
              mkdirSync(directory ?? workspaceRoot, { recursive: true });
              writeFileSync(
                join(directory ?? workspaceRoot, 'suite-summary.json'),
                JSON.stringify({
                  schemaVersion: 1,
                  suiteId: 'node.cleanup',
                  status: 'passed',
                  attempts: 3,
                  retries: 2,
                  durationMs: 45,
                  attemptDurationMs: 30,
                  attemptsByStatus: { passed: 3 },
                }),
              );
              return { status: 9, timedOut: false };
            }),
          },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('status 9'),
          }),
          expect.objectContaining({ message: 'resource cleanup failed' }),
        ]),
      );
      expect(
        JSON.parse(
          readFileSync(
            join(
              workspaceRoot,
              'dist/.playwright/trinity-e2e-node/run-node-clean/node.cleanup/suite-summary.json',
            ),
            'utf8',
          ),
        ),
      ).toMatchObject({
        suiteId: 'node.cleanup',
        status: 'failed',
        attempts: 3,
        retries: 2,
        durationMs: 45,
        attemptDurationMs: 30,
        attemptsByStatus: { passed: 3 },
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('maps explicit recovery to the same support-owned Synapse lease', () => {
    expect(resourceLockFile('synapse')).toBe(synapseLockFile);
    const recover = vi.fn(() => true);
    expect(recoverResourceLock('synapse', recover)).toBe(true);
    expect(recover).toHaveBeenCalledWith(synapseLockFile);
    expect(() => resourceLockFile('not-a-resource')).toThrow(
      /Unknown E2E resource/,
    );
  });

  it('rejects manifest recording without a build or explicit prebuilt reuse', async () => {
    const execute = vi.fn();

    await expect(
      prepareWebBundle(
        {
          bundleManifest: true,
          reusePrebuilt: false,
          environment: {},
          signal: new AbortController().signal,
        },
        execute,
      ),
    ).rejects.toThrow(/requires --build/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('builds then records the production bundle before publishing reuse', async () => {
    const execute = vi.fn().mockResolvedValue({
      status: 0,
      timedOut: false,
    });
    const environment: NodeJS.ProcessEnv = {};

    await expect(
      prepareWebBundle(
        {
          buildTarget: 'trinity:build:production',
          bundleManifest: true,
          reusePrebuilt: false,
          environment,
          signal: new AbortController().signal,
        },
        execute,
      ),
    ).resolves.toBe(0);

    expect(execute).toHaveBeenNthCalledWith(
      1,
      'pnpm',
      ['exec', 'nx', 'run', 'trinity:build:production'],
      expect.objectContaining({ environment }),
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      ['scripts/web-bundle-manifest.mjs', 'write', 'www'],
      expect.objectContaining({ environment }),
    );
    expect(environment['TRINITY_E2E_PREBUILT_WWW']).toBe('1');
  });

  it('verifies an explicitly prebuilt bundle without rebuilding it', async () => {
    const execute = vi.fn().mockResolvedValue({
      status: 0,
      timedOut: false,
    });

    await expect(
      prepareWebBundle(
        {
          bundleManifest: true,
          reusePrebuilt: true,
          environment: {},
          signal: new AbortController().signal,
        },
        execute,
      ),
    ).resolves.toBe(0);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      process.execPath,
      [
        'scripts/web-bundle-manifest.mjs',
        'verify',
        'dist/web-bundle-manifest.json',
        'www',
      ],
      expect.any(Object),
    );
  });

  it('stops after either bundle preparation command fails', async () => {
    const buildFailure = vi.fn().mockResolvedValue({
      status: 7,
      timedOut: false,
    });
    await expect(
      prepareWebBundle(
        {
          buildTarget: 'trinity:build:production',
          bundleManifest: true,
          reusePrebuilt: false,
          environment: {},
          signal: new AbortController().signal,
        },
        buildFailure,
      ),
    ).resolves.toBe(7);
    expect(buildFailure).toHaveBeenCalledOnce();

    const manifestFailure = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, timedOut: false })
      .mockResolvedValueOnce({ status: 9, timedOut: false });
    const environment: NodeJS.ProcessEnv = {};
    await expect(
      prepareWebBundle(
        {
          buildTarget: 'trinity:build:production',
          bundleManifest: true,
          reusePrebuilt: false,
          environment,
          signal: new AbortController().signal,
        },
        manifestFailure,
      ),
    ).resolves.toBe(9);
    expect(manifestFailure).toHaveBeenCalledTimes(2);
    expect(environment['TRINITY_E2E_PREBUILT_WWW']).toBeUndefined();
  });
});
