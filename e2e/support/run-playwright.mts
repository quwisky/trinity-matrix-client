#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openE2EInvocation, type E2EInvocation } from './invocation.mts';
import {
  createProcessTerminationScope,
  runManagedCommand,
} from './managed-command.mts';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Arguments {
  readonly config: string;
  readonly resources: readonly string[];
  readonly buildTarget?: string;
  readonly platform?: string;
  readonly forwarded: readonly string[];
}

function parseArguments(argv: readonly string[]): Arguments {
  let config: string | undefined;
  let buildTarget: string | undefined;
  let platform: string | undefined;
  const resources: string[] = [];
  const separator = argv.indexOf('--');
  const ownArguments = separator < 0 ? argv : argv.slice(0, separator);
  const forwarded: string[] = [];
  for (const argument of ownArguments) {
    if (argument.startsWith('--config=')) config = argument.slice(9);
    else if (argument.startsWith('--build=')) buildTarget = argument.slice(8);
    else if (argument.startsWith('--platform=')) platform = argument.slice(11);
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
  return { config, resources, buildTarget, platform, forwarded };
}

export async function runPlaywright(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  const termination = createProcessTerminationScope();
  let invocation: E2EInvocation | undefined;
  try {
    invocation = await openE2EInvocation({
      resources: options.resources,
      workspaceRoot,
      signal: termination.signal,
    });
    const environment = {
      ...invocation.environment,
      ...(options.platform ? { TRINITY_E2E_PLATFORM: options.platform } : {}),
    };
    if (options.buildTarget) {
      const build = await runManagedCommand(
        'pnpm',
        ['exec', 'nx', 'run', options.buildTarget],
        {
          cwd: workspaceRoot,
          environment,
          timeout: 600_000,
          signal: termination.signal,
        },
      );
      if (build.status !== 0) return build.status;
    }
    const result = await runManagedCommand(
      'pnpm',
      [
        'exec',
        'playwright',
        'test',
        '-c',
        options.config,
        ...options.forwarded,
      ],
      {
        cwd: workspaceRoot,
        environment,
        timeout: 3_600_000,
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
