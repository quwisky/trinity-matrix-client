import { join, resolve } from 'node:path';
import type {
  PlaywrightTestConfig,
  ReporterDescription,
} from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import type { E2ESuiteDefinition } from './e2e-registry.types.mts';
import { assertE2EArtifactPathSegment } from './artifact-path.mts';
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
  | 'availabilityPolicy'
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

interface E2EReportConfigOptions {
  /** Reporters that add suite-specific annotations before artifact reporters serialize. */
  readonly reportersAfterMetadata?: readonly ReporterDescription[];
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

/**
 * The Playwright shard named by `TRINITY_E2E_SHARD` (`<current>/<total>`, one-based).
 * CI runs the browser journeys as one job per shard; unset runs the whole suite.
 * A malformed value throws: silently ignoring it would run every test in every job.
 */
export function e2eShard(
  value: string | undefined = process.env['TRINITY_E2E_SHARD'],
): PlaywrightTestConfig['shard'] {
  if (!value) return null;
  const match = /^(\d+)\/(\d+)$/u.exec(value);
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || current < 1 || current > total) {
    throw new Error(
      `TRINITY_E2E_SHARD must be <current>/<total> with 1 <= current <= total, got ${JSON.stringify(value)}`,
    );
  }
  return { current, total };
}

/**
 * The journey file named by `TRINITY_E2E_SPEC` (a path below the suite's test directory,
 * such as `accounts/mas-session.spec.mts`), as a `testMatch`; unset runs every spec.
 * CI selects the file this way, like the shard, because the E2E registry pins the CI
 * command line and so leaves no room for a path argument. A malformed value throws:
 * silently ignoring it would run the whole suite in a job sized for one file.
 */
export function e2eSpec(
  value: string | undefined = process.env['TRINITY_E2E_SPEC'],
): RegExp | undefined {
  if (!value) return undefined;
  if (!/^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.spec\.mts$/u.test(value)) {
    throw new Error(
      `TRINITY_E2E_SPEC must be a journey path such as accounts/mas-session.spec.mts, got ${JSON.stringify(value)}`,
    );
  }
  return new RegExp(`/${value.replaceAll('.', '\\.')}$`, 'u');
}

/** Resolve one suite path below dist/.playwright/<project>/<run-id>/. */
export function e2eArtifactPath(
  project: string,
  runSuiteId: string,
  leaf: string,
): string {
  assertE2EArtifactPathSegment(project, 'project');
  assertE2EArtifactPathSegment(runSuiteId, 'suite');
  const session = sessionForConfig();
  const root = session
    ? join(session.workspaceRoot, 'dist/.playwright', project, session.id)
    : resolve('dist/.playwright', project, 'nx-config-discovery');
  return join(root, runSuiteId, leaf);
}

/** Shared reporting and evidence policy; suites still own projects and concurrency. */
export function e2eReportConfig(
  suite: E2EReportingSuite,
  options: E2EReportConfigOptions = {},
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
    'trinity.e2e.availabilityPolicy': suite.availabilityPolicy,
    'trinity.e2e.ciTier': suite.ciTier,
  } as const;
  const consoleReporter = process.env['CI'] ? 'dot' : 'list';
  const reporter: NonNullable<PlaywrightTestConfig['reporter']> = [
    [consoleReporter],
    [
      join(import.meta.dirname, 'registry-metadata.reporter.mts'),
      { metadata, outputFile: artifact('suite-summary.json') },
    ],
    ...(options.reportersAfterMetadata ?? []),
    ['blob', { outputDir: artifact('blob-report') }],
    ['junit', { outputFile: artifact('junit/results.xml') }],
  ];
  if (process.env['CI']) reporter.push(['github']);
  reporter.push([
    'html',
    { outputFolder: artifact('html-report'), open: 'never' },
  ]);
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
    retries: process.env['CI'] ? 1 : 0,
    failOnFlakyTests: Boolean(process.env['CI']),
    workers: 1,
    timeout: options.timeout,
    ...(options.expectTimeout
      ? { expect: { timeout: options.expectTimeout } }
      : {}),
    ...e2eReportConfig(options.suite),
    use: {
      baseURL: e2eEndpoint(options.endpoint),
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
    },
  };
}
