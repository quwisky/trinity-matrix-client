import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  acquireProcessLock,
  releaseProcessLock,
  type ProcessLock,
} from '../process-lock.mts';
import {
  resolveHomeserverKind,
  resolveHomeserverRuntime,
  resolveMasEnabled,
} from './kind.mts';
import {
  nativePaths,
  nodeProcessApi,
  runningNativeServices,
} from './native.mts';
import { DATA, STATE_DIR } from './paths.mjs';
import { PORT_OFFSET } from './constants.mjs';

const workspaceRoot = resolve(import.meta.dirname, '../../..');
export const homeserverLockFile = join(
  workspaceRoot,
  'dist/.playwright/homeserver.lock',
);
/** Machine-wide, so checkouts on the same TRINITY_E2E_PORT_OFFSET take turns. */
export const homeserverPortLockFile = join(
  homedir(),
  '.cache/trinity-e2e',
  `homeserver-${PORT_OFFSET}.lock`,
);
const composeFile = join(import.meta.dirname, 'docker-compose.yml');
const exec = promisify(execFile);

/** The port lock, plus this checkout's lock, which agent-guard reads as "checkout busy". */
export interface HomeserverLease extends ProcessLock {
  readonly ports: ProcessLock;
}

function acquireLocks(): HomeserverLease {
  const ports = acquireProcessLock(
    homeserverPortLockFile,
    `Homeserver E2E harness on TRINITY_E2E_PORT_OFFSET=${PORT_OFFSET}`,
  );
  try {
    return {
      ...acquireProcessLock(homeserverLockFile, 'Homeserver E2E harness'),
      ports,
    };
  } catch (error) {
    releaseProcessLock(ports);
    throw error;
  }
}

export async function acquireHomeserverLease(
  signal?: AbortSignal,
): Promise<HomeserverLease> {
  // Every path to the stack takes this lease first, so a bad selection fails here,
  // before a lock file or a container exists.
  resolveHomeserverKind();
  const runtime = resolveHomeserverRuntime();
  resolveMasEnabled();
  const lease = acquireLocks();
  let native: string[];
  try {
    native = runningNativeServices(
      nativePaths(STATE_DIR, DATA).pidFile,
      nodeProcessApi,
    );
  } catch (error) {
    releaseHomeserverLease(lease);
    throw error;
  }
  if (native.length > 0) {
    releaseHomeserverLease(lease);
    throw new Error(
      `An E2E homeserver stack is already running (${native.join(', ')}); stop it before starting another harness`,
    );
  }
  if (runtime === 'native') return lease;
  try {
    const { stdout } = await exec(
      'docker',
      ['compose', '-f', composeFile, 'ps', '--status', 'running', '--services'],
      { cwd: import.meta.dirname, signal },
    );
    if (stdout.trim()) {
      releaseHomeserverLease(lease);
      throw new Error(
        `An E2E homeserver stack is already running (${stdout.trim().replaceAll('\n', ', ')}); stop it before starting another harness`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('already running (')) {
      throw error;
    }
    if (signal?.aborted) {
      releaseHomeserverLease(lease);
      throw signal.reason;
    }
    // Let start.mjs report Docker availability/configuration errors with richer
    // context. The lease still prevents another harness from racing that attempt.
  }
  return lease;
}

/** Claim teardown without rejecting the running stack that teardown is meant to stop. */
export function acquireHomeserverTeardownLease(): HomeserverLease {
  return acquireLocks();
}

export function releaseHomeserverLease(lease: ProcessLock | undefined): void {
  releaseProcessLock(lease);
  if (lease && 'ports' in lease) releaseProcessLock(lease.ports as ProcessLock);
}
