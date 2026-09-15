import { spawn, spawnSync, type StdioOptions } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

export interface ManagedCommandResult {
  readonly status: number;
  readonly signal?: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly error?: Error;
}

export interface ProcessTerminationScope {
  readonly signal: AbortSignal;
  close(): void;
}

interface SignalEventSource {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** Turn process termination into cancellation while the owner retains its finally block. */
export function createProcessTerminationScope(
  source: SignalEventSource = process,
): ProcessTerminationScope {
  const controller = new AbortController();
  const abort = (): void =>
    controller.abort(new Error('E2E invocation interrupted'));
  source.once('SIGINT', abort);
  source.once('SIGTERM', abort);
  return {
    signal: controller.signal,
    close() {
      source.off('SIGINT', abort);
      source.off('SIGTERM', abort);
    },
  };
}

export interface ManagedCommandOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeout?: number;
  readonly terminationGraceMs?: number;
  /** Signal sent to the process tree before the hard kill. */
  readonly terminationSignal?: NodeJS.Signals;
  readonly platform?: NodeJS.Platform;
  readonly stdio?: StdioOptions;
  readonly signal?: AbortSignal;
  /** Clean up descendants that remain after a detached child exits. */
  readonly cleanupProcessGroup?: boolean;
}

function processGroupIsAlive(
  pid: number | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (!pid || platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupHasLiveMembers(
  pid: number | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (!pid || platform === 'win32') return false;
  if (platform === 'linux') {
    try {
      return readdirSync('/proc', { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
        .some((entry) => {
          try {
            const stat = readFileSync(`/proc/${entry.name}/stat`, 'utf8');
            const closingParen = stat.lastIndexOf(')');
            const fields = stat.slice(closingParen + 2).split(' ');
            return (
              fields[0] !== 'Z' &&
              fields[0] !== 'X' &&
              Number(fields[2]) === pid
            );
          } catch {
            return false;
          }
        });
    } catch {
      // Fall through to the portable process-group probe.
    }
  } else if (platform === 'darwin') {
    try {
      const result = spawnSync('ps', ['-eo', 'pgid=,state='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (result.status === 0) {
        return result.stdout.split('\n').some((line) => {
          const [group, state] = line.trim().split(/\s+/u);
          return Number(group) === pid && state !== 'Z' && state !== 'X';
        });
      }
    } catch {
      // Fall through to the portable process-group probe.
    }
  }
  return processGroupIsAlive(pid, platform);
}

function signalProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
): void {
  if (child.pid && platform === 'win32') {
    // Node cannot address a Windows process group. taskkill /T is the platform
    // primitive that terminates the child and every descendant it created.
    const killer = spawn(
      'taskkill',
      [
        '/pid',
        String(child.pid),
        '/t',
        ...(signal === 'SIGKILL' ? ['/f'] : []),
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    killer.once('error', () => child.kill(signal));
    return;
  }
  if (child.pid && platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may exit between the liveness check and signal.
    }
  }
  child.kill(signal);
}

/** Run one command with bounded cancellation of its whole process group. */
export function runManagedCommand(
  command: string,
  args: readonly string[],
  {
    cwd = process.cwd(),
    environment = process.env,
    timeout,
    terminationGraceMs = 10_000,
    terminationSignal = 'SIGTERM',
    platform = process.platform,
    stdio = 'inherit',
    signal,
    cleanupProcessGroup = false,
  }: ManagedCommandOptions = {},
): Promise<ManagedCommandResult> {
  if (signal?.aborted) {
    return Promise.resolve({
      status: 1,
      timedOut: false,
      error:
        signal.reason instanceof Error
          ? signal.reason
          : new Error('E2E command cancelled before start'),
    });
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...environment, NX_DAEMON: 'false' },
      stdio,
      detached: platform !== 'win32',
    });
    let settled = false;
    let terminating = false;
    let timedOut = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    let verificationTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const finish = (result: ManagedCommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (verificationTimer) clearTimeout(verificationTimer);
      signal?.removeEventListener('abort', cancel);
      resolve(result);
    };
    const terminate = (becauseTimeout: boolean): void => {
      if (terminating) return;
      terminating = true;
      timedOut = becauseTimeout;
      if (cleanupProcessGroup && platform !== 'win32') {
        cleanupExitedGroup(
          { status: 1, signal: terminationSignal, timedOut },
          terminationSignal,
        );
        return;
      }
      signalProcessTree(child, terminationSignal, platform);
      terminationTimer = setTimeout(() => {
        signalProcessTree(child, 'SIGKILL', platform);
        verificationTimer = setTimeout(
          () => finish({ status: 1, signal: 'SIGKILL', timedOut }),
          25,
        );
      }, terminationGraceMs);
    };
    const cancel = (): void => terminate(false);

    const cleanupExitedGroup = (
      result: ManagedCommandResult,
      initialSignal: NodeJS.Signals = 'SIGTERM',
    ): void => {
      if (
        !cleanupProcessGroup ||
        platform === 'win32' ||
        !processGroupHasLiveMembers(child.pid, platform)
      ) {
        finish(result);
        return;
      }
      signalProcessTree(child, initialSignal, platform);
      const deadline = Date.now() + terminationGraceMs;
      const verifyGracefulExit = (): void => {
        if (!processGroupHasLiveMembers(child.pid, platform)) {
          finish(result);
          return;
        }
        if (Date.now() < deadline) {
          verificationTimer = setTimeout(verifyGracefulExit, 10);
          return;
        }
        signalProcessTree(child, 'SIGKILL', platform);
        const killDeadline = Date.now() + 250;
        const verifyKill = (): void => {
          if (!processGroupHasLiveMembers(child.pid, platform)) {
            finish(result);
            return;
          }
          if (Date.now() < killDeadline) {
            verificationTimer = setTimeout(verifyKill, 10);
            return;
          }
          finish({
            ...result,
            status: 1,
            error: new Error(
              `Process group ${child.pid ?? 'unknown'} survived cleanup`,
            ),
          });
        };
        verificationTimer = setTimeout(verifyKill, 10);
      };
      verificationTimer = setTimeout(verifyGracefulExit, 0);
    };

    child.once('error', (error) =>
      cleanupExitedGroup({ status: 1, error, timedOut }),
    );
    child.once('exit', (code, exitSignal) => {
      if (
        terminating &&
        processGroupIsAlive(child.pid, platform) &&
        (terminationTimer || verificationTimer)
      ) {
        return;
      }
      cleanupExitedGroup({
        status: terminating ? 1 : (code ?? 1),
        signal: exitSignal,
        timedOut,
      });
    });
    if (typeof timeout === 'number')
      timeoutTimer = setTimeout(() => terminate(true), timeout);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
