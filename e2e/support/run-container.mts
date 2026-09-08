#!/usr/bin/env node
import { resolve } from 'node:path';
import {
  createProcessTerminationScope,
  runManagedCommand,
} from './managed-command.mts';
import { openE2EInvocation } from './invocation.mts';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const termination = createProcessTerminationScope();
let invocation: Awaited<ReturnType<typeof openE2EInvocation>> | undefined;

try {
  invocation = await openE2EInvocation({
    workspaceRoot,
    signal: termination.signal,
  });
  const result = await runManagedCommand(
    process.execPath,
    ['scripts/web-container.mjs', 'smoke'],
    {
      cwd: workspaceRoot,
      environment: invocation.environment,
      timeout: 3_600_000,
      terminationSignal: 'SIGINT',
      terminationGraceMs: 30_000,
      signal: termination.signal,
    },
  );
  process.exitCode = result.status;
} catch (error) {
  console.error('[e2e] container invocation failed:', error);
  process.exitCode = 1;
} finally {
  termination.close();
  await invocation?.close().catch((error: unknown) => {
    console.error('[e2e] container invocation teardown failed:', error);
    process.exitCode = 1;
  });
}
