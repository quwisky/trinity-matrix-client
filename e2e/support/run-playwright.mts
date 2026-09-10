#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openE2EInvocation, type E2EInvocation } from './invocation.mts';
import {
  createProcessTerminationScope,
  runManagedCommand,
} from './managed-command.mts';
import {
  prepareWebBundle,
  type WebBundlePreparation,
} from './web-bundle-preparation.mts';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const playwrightCli = require.resolve('@playwright/test/cli');

interface Arguments {
  readonly config: string;
  readonly resources: readonly string[];
  readonly buildTarget?: string;
  readonly bundleManifest: boolean;
  readonly platform?: string;
  readonly forwarded: readonly string[];
}

function parseArguments(argv: readonly string[]): Arguments {
  let config: string | undefined;
  let buildTarget: string | undefined;
  let platform: string | undefined;
  let bundleManifest = false;
  const resources: string[] = [];
  const separator = argv.indexOf('--');
  const ownArguments = separator < 0 ? argv : argv.slice(0, separator);
  const forwarded: string[] = [];
  for (const argument of ownArguments) {
    if (argument.startsWith('--config=')) config = argument.slice(9);
    else if (argument.startsWith('--build=')) buildTarget = argument.slice(8);
    else if (argument.startsWith('--platform=')) platform = argument.slice(11);
    else if (argument === '--bundle-manifest') bundleManifest = true;
    else if (argument.startsWith('--resource='))
      resources.push(argument.slice(11));
    // Nx run-commands appends forwarded target arguments directly to the command,
    // without preserving the caller's `--` separator. Anything not owned by this
    // wrapper therefore belongs to Playwright.
    else forwarded.push(argument);
  }
  if (separator >= 0) forwarded.push(...argv.slice(separator + 1));
  if (!config)
    throw new Error('E2E Playwright runner requires --config=<path>');
  return {
    config,
    resources,
    buildTarget,
    bundleManifest,
    platform,
    forwarded,
  };
}

export { prepareWebBundle };
export type { WebBundlePreparation };

export async function runPlaywright(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const options = parseArguments(argv);
  const termination = createProcessTerminationScope();
  let invocation: E2EInvocation | undefined;
  try {
    invocation = await openE2EInvocation({
      resources: options.resources,
      workspaceRoot,
      environment,
      signal: termination.signal,
    });
    const invocationEnvironment: NodeJS.ProcessEnv = {
      ...invocation.environment,
      ...(options.platform ? { TRINITY_E2E_PLATFORM: options.platform } : {}),
    };
    const reusingPrebuiltBundle =
      options.bundleManifest && environment['TRINITY_E2E_PREBUILT_WWW'] === '1';
    const prepared = await prepareWebBundle({
      buildTarget: options.buildTarget,
      bundleManifest: options.bundleManifest,
      reusePrebuilt: reusingPrebuiltBundle,
      environment: invocationEnvironment,
      signal: termination.signal,
    });
    if (prepared !== 0) return prepared;
    // Own the reporter process directly: an intermediate package-manager process
    // can forward a second termination signal before Playwright flushes reports.
    const result = await runManagedCommand(
      process.execPath,
      [playwrightCli, 'test', '-c', options.config, ...options.forwarded],
      {
        cwd: workspaceRoot,
        environment: invocationEnvironment,
        timeout: 3_600_000,
        terminationSignal: 'SIGINT',
        terminationGraceMs: 30_000,
        signal: termination.signal,
      },
    );
    return result.status;
  } finally {
    termination.close();
    await invocation?.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runPlaywright(process.argv.slice(2));
  } catch (error) {
    console.error('[e2e] Playwright invocation failed:', error);
    process.exitCode = 1;
  }
}
