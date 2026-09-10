#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readPlaywrightSuiteSummary,
  suiteSummaryPath,
} from './execution-report.mts';
import { openE2EInvocation, type E2EInvocation } from './invocation.mts';
import {
  createProcessTerminationScope,
  runManagedCommand,
} from './managed-command.mts';
import {
  prepareWebBundle,
  webBundleWorkspaceRoot,
} from './web-bundle-preparation.mts';

const MAX_TIMEOUT_MS = 2_147_483_647;

export interface NodeRunnerArguments {
  readonly suite: string;
  readonly entrypoints: readonly string[];
  readonly resources: readonly string[];
  readonly buildTarget?: string;
  readonly bundleManifest: boolean;
  readonly platform?: string;
  readonly timeoutMs: number;
  readonly forwarded: readonly string[];
}

export interface NodeRunnerDependencies {
  readonly openInvocation?: typeof openE2EInvocation;
  readonly prepareBundle?: typeof prepareWebBundle;
  readonly executeCommand?: typeof runManagedCommand;
  readonly workspaceRoot?: string;
}

function parseArguments(argv: readonly string[]): NodeRunnerArguments {
  let suite: string | undefined;
  let buildTarget: string | undefined;
  let platform: string | undefined;
  let timeoutMs = 3_600_000;
  let bundleManifest = false;
  const entrypoints: string[] = [];
  const resources: string[] = [];
  const separator = argv.indexOf('--');
  const ownArguments = separator < 0 ? argv : argv.slice(0, separator);
  const forwarded: string[] = [];
  for (const argument of ownArguments) {
    if (argument.startsWith('--suite=')) suite = argument.slice(8);
    else if (argument.startsWith('--entrypoint='))
      entrypoints.push(argument.slice(13));
    else if (argument.startsWith('--build=')) buildTarget = argument.slice(8);
    else if (argument.startsWith('--platform=')) platform = argument.slice(11);
    else if (argument.startsWith('--timeout-ms=')) {
      const value = Number(argument.slice(13));
      if (
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > MAX_TIMEOUT_MS
      ) {
        throw new Error(
          'E2E Node runner requires --timeout-ms=<positive integer <= 2147483647>',
        );
      }
      timeoutMs = value;
    } else if (argument === '--bundle-manifest') bundleManifest = true;
    else if (argument.startsWith('--resource='))
      resources.push(argument.slice(11));
    else forwarded.push(argument);
  }
  if (separator >= 0) forwarded.push(...argv.slice(separator + 1));
  if (!suite) throw new Error('E2E Node runner requires --suite=<stable-id>');
  if (entrypoints.length === 0) {
    throw new Error(
      'E2E Node runner requires at least one --entrypoint=<file>',
    );
  }
  return {
    suite,
    entrypoints,
    resources,
    buildTarget,
    bundleManifest,
    platform,
    timeoutMs,
    forwarded,
  };
}

function runnerEnvironment(
  environment: NodeJS.ProcessEnv,
  options: NodeRunnerArguments,
  workspaceRoot: string,
  runId: string,
  inherited: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const project =
    environment['TRINITY_E2E_PROJECT'] ??
    `trinity-e2e-${options.platform ?? options.suite.split('.')[0]}`;
  return {
    ...environment,
    ...inherited,
    TRINITY_E2E_SUITE_ID: options.suite,
    TRINITY_E2E_PROJECT: project,
    TRINITY_E2E_RUN_ID: runId,
    TRINITY_E2E_REPORT_DIR: dirname(
      suiteSummaryPath(workspaceRoot, project, runId, options.suite),
    ),
    ...(options.platform ? { TRINITY_E2E_PLATFORM: options.platform } : {}),
  };
}

function writeTerminalSummary(
  environment: NodeJS.ProcessEnv,
  suite: string,
  status: 'failed' | 'interrupted',
  detail: unknown,
  force = false,
): void {
  const directory = environment['TRINITY_E2E_REPORT_DIR'];
  if (!directory) return;
  mkdirSync(join(directory, 'junit'), { recursive: true });
  const summaryFile = join(directory, 'suite-summary.json');
  // A reporter-produced summary is authoritative after a normal child exit.
  // Fallback writes are only used when startup, teardown, or interruption left
  // no terminal artifact behind.
  let existing: Record<string, unknown> | undefined;
  if (existsSync(summaryFile)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(summaryFile, 'utf8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      )
        existing = parsed as Record<string, unknown>;
    } catch {
      // Replace a partial reporter write with a valid terminal summary.
    }
  }
  if (existing && !force) return;
  const message = detail instanceof Error ? detail.message : String(detail);
  writeFileSync(
    summaryFile,
    `${JSON.stringify(
      {
        ...(existing ?? {}),
        schemaVersion: 1,
        suiteId: suite,
        status,
        attempts:
          typeof existing?.['attempts'] === 'number' ? existing['attempts'] : 0,
        retries:
          typeof existing?.['retries'] === 'number' ? existing['retries'] : 0,
        durationMs:
          typeof existing?.['durationMs'] === 'number'
            ? existing['durationMs']
            : 0,
        attemptDurationMs:
          typeof existing?.['attemptDurationMs'] === 'number'
            ? existing['attemptDurationMs']
            : 0,
        attemptsByStatus: existing?.['attemptsByStatus'] ?? { failed: 1 },
        detail: message,
      },
      undefined,
      2,
    )}\n`,
  );
}

function summaryFile(environment: NodeJS.ProcessEnv): string | undefined {
  const directory = environment['TRINITY_E2E_REPORT_DIR'];
  return directory ? join(directory, 'suite-summary.json') : undefined;
}

function validateTerminalSummary(
  environment: NodeJS.ProcessEnv,
  suite: string,
): {
  readonly valid: boolean;
  readonly detail: string;
  readonly force: boolean;
} {
  const file = summaryFile(environment);
  if (!file) {
    return {
      valid: false,
      detail: 'Node reporter directory was not configured',
      force: false,
    };
  }
  try {
    const summary = readPlaywrightSuiteSummary(file);
    if (!summary)
      return {
        valid: false,
        detail: 'Node test emitted no execution summary',
        force: false,
      };
    if (summary.suiteId !== suite) {
      return {
        valid: false,
        detail: `Node test summary identified ${summary.suiteId}`,
        force: true,
      };
    }
    if (summary.status !== 'passed') {
      return {
        valid: false,
        detail: `Node test summary reported ${summary.status}`,
        force: false,
      };
    }
    return { valid: true, detail: '', force: false };
  } catch (error) {
    return {
      valid: false,
      detail: error instanceof Error ? error.message : String(error),
      force: true,
    };
  }
}

export async function runNode(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: NodeRunnerDependencies = {},
): Promise<number> {
  const options = parseArguments(argv);
  const workspaceRoot = resolve(
    dependencies.workspaceRoot ?? webBundleWorkspaceRoot,
  );
  const openInvocation = dependencies.openInvocation ?? openE2EInvocation;
  const prepareBundle = dependencies.prepareBundle ?? prepareWebBundle;
  const executeCommand = dependencies.executeCommand ?? runManagedCommand;
  const termination = createProcessTerminationScope();
  let invocation: E2EInvocation | undefined;
  const startupRunId =
    environment['TRINITY_E2E_RUN_ID'] ??
    `startup-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  let invocationEnvironment: NodeJS.ProcessEnv = runnerEnvironment(
    environment,
    options,
    workspaceRoot,
    startupRunId,
  );
  let failure: unknown;
  let result = 1;
  try {
    invocation = await openInvocation({
      resources: options.resources,
      workspaceRoot,
      environment,
      signal: termination.signal,
    });
    invocationEnvironment = runnerEnvironment(
      environment,
      options,
      workspaceRoot,
      invocation.descriptor.id,
      invocation.environment,
    );
    const prepared = await prepareBundle({
      buildTarget: options.buildTarget,
      bundleManifest: options.bundleManifest,
      reusePrebuilt:
        options.bundleManifest &&
        environment['TRINITY_E2E_PREBUILT_WWW'] === '1',
      environment: invocationEnvironment,
      signal: termination.signal,
    });
    if (prepared !== 0) {
      failure = new Error(
        `Web bundle preparation exited with status ${prepared}`,
      );
      writeTerminalSummary(
        invocationEnvironment,
        options.suite,
        termination.signal.aborted ? 'interrupted' : 'failed',
        failure,
      );
      return prepared;
    }

    const commandResult = await executeCommand(
      process.execPath,
      [
        '--test',
        '--test-concurrency=1',
        '--test-reporter',
        join(workspaceRoot, 'e2e/support/node-reporter.mts'),
        '--test-reporter-destination',
        'stdout',
        ...options.forwarded,
        ...options.entrypoints,
      ],
      {
        cwd: workspaceRoot,
        environment: invocationEnvironment,
        timeout: options.timeoutMs,
        terminationSignal: 'SIGINT',
        terminationGraceMs: 10_000,
        cleanupProcessGroup: true,
        signal: termination.signal,
      },
    );
    result = commandResult.status;
    if (result !== 0) {
      failure =
        commandResult.error ??
        new Error(`Node test process exited with status ${result}`);
      writeTerminalSummary(
        invocationEnvironment,
        options.suite,
        termination.signal.aborted ? 'interrupted' : 'failed',
        failure,
        true,
      );
    }
    if (result === 0) {
      const summary = validateTerminalSummary(
        invocationEnvironment,
        options.suite,
      );
      if (!summary.valid) {
        failure = new Error(summary.detail);
        writeTerminalSummary(
          invocationEnvironment,
          options.suite,
          'failed',
          failure,
          summary.force,
        );
        return 1;
      }
    }
    return result;
  } catch (error) {
    failure = error;
    if (invocationEnvironment)
      writeTerminalSummary(
        invocationEnvironment,
        options.suite,
        termination.signal.aborted ? 'interrupted' : 'failed',
        error,
      );
    throw error;
  } finally {
    termination.close();
    try {
      await invocation?.close();
    } catch (error) {
      if (invocationEnvironment)
        writeTerminalSummary(
          invocationEnvironment,
          options.suite,
          'failed',
          error,
          true,
        );
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, error],
          'Node E2E invocation failed during teardown',
        );
      }
      throw error;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runNode(process.argv.slice(2));
  } catch (error) {
    console.error('[e2e] Node invocation failed:', error);
    process.exitCode = 1;
  }
}
