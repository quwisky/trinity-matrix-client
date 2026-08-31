import { join, resolve } from 'node:path';
import type { PlaywrightTestConfig } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import type { E2ESuiteDefinition } from './e2e-registry.types.mts';
import {
  E2E_SESSION_ENV,
  readSession,
  type E2ESessionDescriptor,
} from './session.mts';

export type E2EEndpoint = 'application' | 'report' | 'storybook';

type E2EReportingSuite = Pick<
  E2ESuiteDefinition,
  | 'id'
  | 'environment'
  | 'capabilities'
  | 'contractTypes'
  | 'targetProject'
  | 'prerequisites'
  | 'ciTier'
>;

interface E2ELifecycleConfigOptions {
  readonly suite: E2EReportingSuite;
  readonly projectRoot: string;
  readonly testDir: string;
  readonly endpoint: E2EEndpoint;
  readonly timeout: number;
  readonly expectTimeout?: number;
}

function sessionForConfig(): E2ESessionDescriptor | undefined {
  if (process.env[E2E_SESSION_ENV]) return readSession();
  // Nx's Playwright inference plugin imports config files while building the project
  // graph. It never starts a browser. Give only that plugin worker inert metadata so
  // ordinary Nx commands can discover projects; every executable path still fails
  // closed unless the invocation owner published a validated descriptor.
  if (
    (globalThis as typeof globalThis & { NX_PLUGIN_WORKER?: boolean })
      .NX_PLUGIN_WORKER
  ) {
    return undefined;
  }
  return readSession();
}

/** Read one owner-bound endpoint without embedding a repository-wide fixed port. */
export function e2eEndpoint(endpoint: E2EEndpoint): string {
  return sessionForConfig()?.endpoints[endpoint] ?? 'http://127.0.0.1:1';
}

function assertPathSegment(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9.-]*$/u.test(value)) {
    throw new Error(`Invalid E2E ${label} path segment: ${value}`);
  }
}

/** Resolve one suite path below dist/.playwright/<project>/<run-id>/. */
export function e2eArtifactPath(
  project: string,
  runSuiteId: string,
  leaf: string,
): string {
  assertPathSegment(project, 'project');
  assertPathSegment(runSuiteId, 'suite');
  const session = sessionForConfig();
  const root = session
    ? join(session.workspaceRoot, 'dist/.playwright', project, session.id)
    : resolve('dist/.playwright', project, 'nx-config-discovery');
  return join(root, runSuiteId, leaf);
}

/** Shared reporting and evidence policy; suites still own projects and concurrency. */
export function e2eReportConfig(
  suite: E2EReportingSuite,
): Pick<PlaywrightTestConfig, 'metadata' | 'outputDir' | 'reporter'> {
  const artifact = (leaf: string): string =>
    e2eArtifactPath(suite.targetProject, suite.id, leaf);
  const metadata = {
    'trinity.e2e.suite': suite.id,
    'trinity.e2e.project': suite.targetProject,
    'trinity.e2e.environment': suite.environment,
    'trinity.e2e.capabilities': suite.capabilities.join(','),
    'trinity.e2e.contractTypes': suite.contractTypes.join(','),
    'trinity.e2e.prerequisites': suite.prerequisites.join(','),
    'trinity.e2e.ciTier': suite.ciTier,
  } as const;
  const consoleReporter = process.env['CI'] ? 'dot' : 'list';
  const reporter: NonNullable<PlaywrightTestConfig['reporter']> = [
    [consoleReporter],
    [join(import.meta.dirname, 'registry-metadata.reporter.mts'), { metadata }],
    ['blob', { outputDir: artifact('blob-report') }],
    ['junit', { outputFile: artifact('junit/results.xml') }],
  ];
  if (!process.env['CI']) {
    reporter.push([
      'html',
      { outputFolder: artifact('html-report'), open: 'never' },
    ]);
  }
  return {
    metadata,
    outputDir: artifact('test-output'),
    reporter,
  };
}

/** Common lifecycle shape; configs still declare engines and suite-specific use policy. */
export function e2eLifecycleConfig(
  options: E2ELifecycleConfigOptions,
): PlaywrightTestConfig {
  return {
    ...nxE2EPreset(options.projectRoot, { testDir: options.testDir }),
    retries: 0,
    workers: 1,
    timeout: options.timeout,
    ...(options.expectTimeout
      ? { expect: { timeout: options.expectTimeout } }
      : {}),
    ...e2eReportConfig(options.suite),
    use: {
      baseURL: e2eEndpoint(options.endpoint),
      trace: 'retain-on-failure',
    },
  };
}
