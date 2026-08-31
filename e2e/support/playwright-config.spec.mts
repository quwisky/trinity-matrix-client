import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  });

  it('copies registry identity into per-test annotations consumed by JUnit', () => {
    const testCase = {
      annotations: [{ type: 'existing', description: 'preserved' }],
    };
    const reporter = new RegistryMetadataReporter({
      metadata: {
        'trinity.e2e.suite': 'web.production-pwa',
        'trinity.e2e.project': 'trinity-e2e-web',
      },
    });

    reporter.onBegin({} as never, { allTests: () => [testCase] } as never);

    expect(testCase.annotations).toEqual([
      { type: 'existing', description: 'preserved' },
      {
        type: 'trinity.e2e.suite',
        description: 'web.production-pwa',
      },
      {
        type: 'trinity.e2e.project',
        description: 'trinity-e2e-web',
      },
    ]);
  });

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
      retries: 0,
      workers: 1,
      timeout: 90_000,
      expect: { timeout: 30_000 },
      use: {
        baseURL: 'http://127.0.0.1:41001',
        trace: 'retain-on-failure',
      },
    });
    expect(config.projects).toBeUndefined();
  });
});
