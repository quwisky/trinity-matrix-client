import { spawn, type StdioOptions } from 'node:child_process';

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
  readonly platform?: NodeJS.Platform;
  readonly stdio?: StdioOptions;
  readonly signal?: AbortSignal;
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
    platform = process.platform,
    stdio = 'inherit',
    signal,
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
    let timeoutTimer: NodeJS.Timeout | undefined;

    const finish = (result: ManagedCommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      signal?.removeEventListener('abort', cancel);
      resolve(result);
    };
    const terminate = (becauseTimeout: boolean): void => {
      if (terminating) return;
      terminating = true;
      timedOut = becauseTimeout;
      signalProcessTree(child, 'SIGTERM', platform);
      terminationTimer = setTimeout(() => {
        signalProcessTree(child, 'SIGKILL', platform);
        finish({ status: 1, signal: 'SIGKILL', timedOut });
      }, terminationGraceMs);
    };
    const cancel = (): void => terminate(false);

    child.once('error', (error) => finish({ status: 1, error, timedOut }));
    child.once('exit', (code, exitSignal) => {
      if (
        terminating &&
        processGroupIsAlive(child.pid, platform) &&
        terminationTimer
      ) {
        return;
      }
      finish({ status: code ?? 1, signal: exitSignal, timedOut });
    });
    if (typeof timeout === 'number')
      timeoutTimer = setTimeout(() => terminate(true), timeout);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
