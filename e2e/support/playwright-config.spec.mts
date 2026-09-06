import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  e2eArtifactPath,
  e2eEndpoint,
  e2eLifecycleConfig,
  e2eReportConfig,
} from './playwright-config.mts';
import {
  E2E_SESSION_ENV,
  E2E_SESSION_VERSION,
  writeSession,
  type E2ESessionDescriptor,
} from './session.mts';
import RegistryMetadataReporter from './registry-metadata.reporter.mts';

const directories: string[] = [];
const previousSession = process.env[E2E_SESSION_ENV];
const previousPluginWorker = (
  globalThis as typeof globalThis & { NX_PLUGIN_WORKER?: boolean }
).NX_PLUGIN_WORKER;

const reportingSuite = {
  id: 'web.production-pwa',
  environment: 'web',
  capabilities: ['composition', 'host'],
  contractTypes: ['host', 'journey'],
  targetProject: 'trinity-e2e-web',
  prerequisites: ['playwright-chromium'],
  availabilityPolicy: 'required',
  ciTier: 'local-only',
} as const;

afterEach(() => {
  if (previousSession === undefined) delete process.env[E2E_SESSION_ENV];
  else process.env[E2E_SESSION_ENV] = previousSession;
  const global = globalThis as typeof globalThis & {
    NX_PLUGIN_WORKER?: boolean;
  };
  if (previousPluginWorker === undefined) delete global.NX_PLUGIN_WORKER;
  else global.NX_PLUGIN_WORKER = previousPluginWorker;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function installSession(): E2ESessionDescriptor {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'trinity-config-'));
  directories.push(workspaceRoot);
  const descriptor: E2ESessionDescriptor = {
    version: E2E_SESSION_VERSION,
    id: 'config-session',
    workspaceRoot,
    owner: {
      pid: process.pid,
      nonce: 'config-nonce',
      createdAt: new Date().toISOString(),
    },
    resources: [],
    endpoints: {
      application: 'http://127.0.0.1:41001',
      storybook: 'http://127.0.0.1:41002',
      report: 'http://127.0.0.1:41003',
    },
    artifactsRoot: join(workspaceRoot, 'dist/.playwright/config-session'),
  };
  const file = join(workspaceRoot, 'session.json');
  writeSession(file, descriptor);
  process.env[E2E_SESSION_ENV] = file;
  return descriptor;
}

describe('Playwright config primitives', () => {
  it('fails closed when there is no invocation descriptor', () => {
    delete process.env[E2E_SESSION_ENV];
    delete (globalThis as typeof globalThis & { NX_PLUGIN_WORKER?: boolean })
      .NX_PLUGIN_WORKER;
    expect(() => e2eEndpoint('application')).toThrow(E2E_SESSION_ENV);
    expect(() =>
      e2eArtifactPath('trinity-e2e-web', 'web.production-pwa', 'output'),
    ).toThrow(E2E_SESSION_ENV);
  });

  it('exposes inert paths only to Nx project-graph discovery', () => {
    delete process.env[E2E_SESSION_ENV];
    (
      globalThis as typeof globalThis & { NX_PLUGIN_WORKER?: boolean }
    ).NX_PLUGIN_WORKER = true;
    expect(e2eEndpoint('application')).toBe('http://127.0.0.1:1');
    expect(
      e2eArtifactPath('trinity-e2e-web', 'web.production-pwa', 'output'),
    ).toContain(
      'trinity-e2e-web/nx-config-discovery/web.production-pwa/output',
    );
  });

  it('binds endpoints and reports to the project and owner-scoped run root', () => {
    const descriptor = installSession();
    expect(e2eEndpoint('application')).toBe(descriptor.endpoints.application);
    expect(
      e2eArtifactPath('trinity-e2e-web', 'web.production-pwa', 'test-output'),
    ).toBe(
      join(
        descriptor.workspaceRoot,
        'dist/.playwright/trinity-e2e-web/config-session/web.production-pwa/test-output',
      ),
    );
    const report = e2eReportConfig(reportingSuite);
    expect(report.outputDir).toBe(
      join(
        descriptor.workspaceRoot,
        'dist/.playwright/trinity-e2e-web/config-session/web.production-pwa/test-output',
      ),
    );
    expect(report.metadata).toMatchObject({
      'trinity.e2e.suite': 'web.production-pwa',
      'trinity.e2e.project': 'trinity-e2e-web',
    });
    expect(JSON.stringify(report.reporter)).toContain('blob-report');
    expect(JSON.stringify(report.reporter)).toContain('junit/results.xml');
    expect(JSON.stringify(report.reporter)).toContain('html-report');
    expect(JSON.stringify(report.reporter)).toContain('suite-summary.json');
  });

  it('enables CI flaky failure and GitHub reporting while retaining HTML', () => {
    installSession();
    const previousCi = process.env['CI'];
    process.env['CI'] = 'true';
    try {
      const report = e2eReportConfig(reportingSuite);
      expect(report.reporter).toEqual(
        expect.arrayContaining([
          ['github'],
          ['html', expect.objectContaining({ open: 'never' })],
        ]),
      );
      const config = e2eLifecycleConfig({
        suite: reportingSuite,
        projectRoot: import.meta.dirname,
        testDir: '.',
        endpoint: 'application',
        timeout: 90_000,
      });
      expect(config).toMatchObject({ retries: 1, failOnFlakyTests: true });
    } finally {
      if (previousCi === undefined) delete process.env['CI'];
      else process.env['CI'] = previousCi;
    }
  });

  it('restores registry identity after the worker replaces annotations', () => {
    const testCase = {
      id: 'one',
      annotations: [] as Array<{ type: string; description?: string }>,
    };
    const result = {
      annotations: [{ type: 'worker', description: 'preserved' }],
      duration: 42,
      retry: 0,
      status: 'passed',
    };
    const reporter = new RegistryMetadataReporter({
      metadata: {
        'trinity.e2e.suite': 'web.production-pwa',
        'trinity.e2e.project': 'trinity-e2e-web',
      },
    });

    reporter.onTestEnd(testCase as never, result as never);

    expect(testCase.annotations).toEqual([
      {
        type: 'trinity.e2e.suite',
        description: 'web.production-pwa',
      },
      {
        type: 'trinity.e2e.project',
        description: 'trinity-e2e-web',
      },
    ]);
    expect(result.annotations).toEqual([
      { type: 'worker', description: 'preserved' },
      ...testCase.annotations,
    ]);
  });

  it('preserves registry identity in generated JUnit XML', () => {
    const workspaceRoot = resolve(import.meta.dirname, '../..');
    const directory = mkdtempSync(join(tmpdir(), 'trinity-junit-'));
    directories.push(directory);
    const specFile = join(directory, 'registry-metadata.pw.mts');
    const configFile = join(directory, 'playwright.config.mts');
    const junitFile = join(directory, 'results.xml');
    const summaryFile = join(directory, 'suite-summary.json');
    const playwrightImport = pathToFileURL(
      join(workspaceRoot, 'node_modules/@playwright/test/index.mjs'),
    ).href;
    const reporterPath = join(
      workspaceRoot,
      'e2e/support/registry-metadata.reporter.mts',
    );

    writeFileSync(
      specFile,
      `import { expect, test } from ${JSON.stringify(playwrightImport)};\n` +
        `test('worker round-trip', async ({}, testInfo) => {\n` +
        `  testInfo.annotations.push({ type: 'worker', description: 'kept' });\n` +
        `  expect(true).toBe(true);\n` +
        `});\n`,
    );
    writeFileSync(
      configFile,
      `export default {\n` +
        `  testDir: ${JSON.stringify(directory)},\n` +
        `  testMatch: 'registry-metadata.pw.mts',\n` +
        `  outputDir: ${JSON.stringify(join(directory, 'test-output'))},\n` +
        `  reporter: [\n` +
        `    [${JSON.stringify(reporterPath)}, { outputFile: ${JSON.stringify(summaryFile)}, metadata: {\n` +
        `      'trinity.e2e.suite': 'web.production-pwa',\n` +
        `      'trinity.e2e.project': 'trinity-e2e-web',\n` +
        `    } }],\n` +
        `    ['junit', { outputFile: ${JSON.stringify(junitFile)} }],\n` +
        `  ],\n` +
        `};\n`,
    );

    const run = spawnSync(
      process.execPath,
      [
        join(workspaceRoot, 'node_modules/playwright/cli.js'),
        'test',
        '--config',
        configFile,
      ],
      { cwd: workspaceRoot, encoding: 'utf8' },
    );
    expect(run.status, run.stderr || run.stdout).toBe(0);
    expect(readFileSync(junitFile, 'utf8')).toContain(
      '<property name="trinity.e2e.suite" value="web.production-pwa">',
    );
    expect(readFileSync(junitFile, 'utf8')).toContain(
      '<property name="trinity.e2e.project" value="trinity-e2e-web">',
    );
    expect(JSON.parse(readFileSync(summaryFile, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      suiteId: 'web.production-pwa',
      status: 'passed',
      attempts: 1,
      retries: 0,
      attemptsByStatus: { passed: 1 },
    });
  }, 30_000);

  it('composes lifecycle defaults without hiding suite-owned browser projects', () => {
    installSession();
    const config = e2eLifecycleConfig({
      suite: reportingSuite,
      projectRoot: import.meta.dirname,
      testDir: '.',
      endpoint: 'application',
      timeout: 90_000,
      expectTimeout: 30_000,
    });

    expect(config).toMatchObject({
      retries: process.env['CI'] ? 1 : 0,
      failOnFlakyTests: Boolean(process.env['CI']),
      workers: 1,
      timeout: 90_000,
      expect: { timeout: 30_000 },
      use: {
        baseURL: 'http://127.0.0.1:41001',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
      },
    });
    expect(config.projects).toBeUndefined();
  });
});
