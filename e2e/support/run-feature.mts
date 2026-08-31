#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openE2EInvocation, type E2EInvocation } from './invocation.mts';
import {
  createProcessTerminationScope,
  runManagedCommand,
} from './managed-command.mts';

const defaultWorkspaceRoot = resolve(import.meta.dirname, '../..');

export async function runFeature(
  argv: readonly string[],
  workspaceRoot = defaultWorkspaceRoot,
): Promise<number> {
  let feature: string | undefined;
  let buildTarget: string | undefined;
  const resources: string[] = [];
  const separator = argv.indexOf('--');
  const ownArguments = separator < 0 ? argv : argv.slice(0, separator);
  const forwarded = separator < 0 ? [] : argv.slice(separator + 1);
  for (const argument of ownArguments) {
    if (argument.startsWith('--feature=')) feature = argument.slice(10);
    else if (argument.startsWith('--build=')) buildTarget = argument.slice(8);
    else if (argument.startsWith('--resource='))
      resources.push(argument.slice(11));
    else throw new Error(`Unknown E2E feature runner option: ${argument}`);
  }
  if (!feature || !/^[a-z0-9-]+$/.test(feature)) {
    throw new Error('E2E feature runner requires --feature=<safe-name>');
  }

  const termination = createProcessTerminationScope();
  let invocation: E2EInvocation | undefined;
  try {
    invocation = await openE2EInvocation({
      resources,
      workspaceRoot,
      signal: termination.signal,
    });
    if (buildTarget) {
      const build = await runManagedCommand(
        'pnpm',
        ['exec', 'nx', 'run', buildTarget],
        {
          cwd: workspaceRoot,
          environment: invocation.environment,
          timeout: 600_000,
          signal: termination.signal,
        },
      );
      if (build.status !== 0) return build.status;
    }
    return (
      await runManagedCommand(
        process.execPath,
        [join(workspaceRoot, 'e2e/features', `${feature}.mjs`), ...forwarded],
        {
          cwd: workspaceRoot,
          environment: invocation.environment,
          timeout: 1_800_000,
          signal: termination.signal,
        },
      )
    ).status;
  } finally {
    termination.close();
    await invocation?.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runFeature(process.argv.slice(2));
  } catch (error) {
    console.error('[e2e] feature invocation failed:', error);
    process.exitCode = 1;
  }
}
