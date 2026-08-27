import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  acquireProcessLock,
  releaseProcessLock,
  type ProcessLock,
} from '../support/process-lock.mts';

const lockFile = join(
  import.meta.dirname,
  '../../dist/.playwright/synapse.lock',
);
const composeFile = join(import.meta.dirname, 'docker-compose.yml');
const exec = promisify(execFile);

export async function acquireSynapseLease(
  signal?: AbortSignal,
): Promise<ProcessLock> {
  const lease = acquireProcessLock(lockFile, 'Synapse E2E harness');
  try {
    const { stdout } = await exec(
      'docker',
      ['compose', '-f', composeFile, 'ps', '--status', 'running', '--services'],
      { cwd: import.meta.dirname, signal },
    );
    if (stdout.trim()) {
      releaseProcessLock(lease);
      throw new Error(
        `A Synapse E2E stack is already running (${stdout.trim().replaceAll('\n', ', ')}); stop it before starting another harness`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('already running (')) {
      throw error;
    }
    if (signal?.aborted) {
      releaseProcessLock(lease);
      throw signal.reason;
    }
    // Let start.mjs report Docker availability/configuration errors with richer
    // context. The lease still prevents another harness from racing that attempt.
  }
  return lease;
}

/** Claim teardown without rejecting the running stack that teardown is meant to stop. */
export function acquireSynapseTeardownLease(): ProcessLock {
  return acquireProcessLock(lockFile, 'Synapse E2E harness');
}

export function releaseSynapseLease(lease: ProcessLock | undefined): void {
  releaseProcessLock(lease);
}
