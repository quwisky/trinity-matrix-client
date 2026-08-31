import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openE2EInvocation } from '../e2e/support/invocation.mts';
import {
  createProcessTerminationScope,
  runManagedCommand,
} from '../e2e/support/managed-command.mts';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

async function run(command, args, environment, signal) {
  const result = await runManagedCommand(command, args, {
    cwd: workspaceRoot,
    environment: { ...process.env, ...environment },
    stdio: 'inherit',
    timeout: 1_800_000,
    signal,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status}`);
}

const termination = createProcessTerminationScope();
let invocation;
try {
  invocation = await openE2EInvocation({
    resources: ['synapse'],
    workspaceRoot,
    signal: termination.signal,
  });
  if (process.env['TRINITY_E2E_PREBUILT_WWW']) {
    await run(
      process.execPath,
      [
        'scripts/web-bundle-manifest.mjs',
        'verify',
        'dist/web-bundle-manifest.json',
        'www',
      ],
      invocation.environment,
      termination.signal,
    );
  } else {
    await run(
      pnpm,
      ['run', 'build'],
      invocation.environment,
      termination.signal,
    );
    await run(
      process.execPath,
      ['scripts/web-bundle-manifest.mjs', 'write', 'www'],
      invocation.environment,
      termination.signal,
    );
  }
  await run(
    pnpm,
    [
      'exec',
      'playwright',
      'test',
      '-c',
      'e2e/playwright.phase7.config.mts',
      ...process.argv.slice(2),
    ],
    { ...invocation.environment, TRINITY_E2E_PREBUILT_WWW: '1' },
    termination.signal,
  );
} finally {
  termination.close();
  await invocation?.close();
}
