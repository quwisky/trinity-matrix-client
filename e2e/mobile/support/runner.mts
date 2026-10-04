import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  openE2EInvocation,
  type E2EInvocation,
} from '../../support/invocation.mts';
import { scrubDirectory } from './scrub.mts';

const exec = promisify(execFile);

/** The repository root; every mobile runner command runs from here. */
export const workspaceRoot = join(import.meta.dirname, '../../..');

const abortController = new AbortController();
let activeChild: ChildProcess | undefined;
let cleaningUp = false;
let requestedExitCode: number | undefined;
let signalCount = 0;

export interface ChildWatchdog {
  readonly failure: Error | undefined;
  stop(): void;
}

/** One platform's device lifecycle; the shared runner owns invocation, signals and scrub. */
export interface MobileRunner {
  readonly platform: 'Android' | 'iOS';
  readonly resources: readonly string[];
  /** This run's host-output directory; its parent (the suite directory) is scrubbed on exit. */
  artifactsDir(): string;
  main(invocation: E2EInvocation): Promise<void>;
  /** Capture diagnostics and release the device; its failures never mask the run's own. */
  releaseDevice(): Promise<void>;
}

/** Aborted by the first SIGINT/SIGTERM; cleanup commands run without it. */
export function commandSignal(): AbortSignal | undefined {
  return cleaningUp ? undefined : abortController.signal;
}
export const isCleaningUp = (): boolean => cleaningUp;
export const runAborted = (): boolean => abortController.signal.aborted;
export const throwIfAborted = (): void =>
  abortController.signal.throwIfAborted();
export const activeChildPid = (): number | undefined => activeChild?.pid;

export function terminateProcessGroup(
  child: ChildProcess | undefined,
  signal: NodeJS.Signals,
): void {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** Run one command at a time in its own process group, inheriting stdio. */
export async function run(
  command: string,
  args: readonly string[],
  watch?: (terminate: (signal: NodeJS.Signals) => void) => ChildWatchdog,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: workspaceRoot,
      env: process.env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    activeChild = child;
    const watchdog = watch?.((signal) => {
      if (activeChild === child) terminateProcessGroup(child, signal);
    });
    const finish = (): void => {
      watchdog?.stop();
      if (activeChild === child) activeChild = undefined;
    };
    child.once('error', (error) => {
      finish();
      reject(watchdog?.failure ?? error);
    });
    child.once('exit', (code, signalName) => {
      finish();
      if (watchdog?.failure) reject(watchdog.failure);
      else if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signalName}`));
    });
  });
}

export async function waitUntil(
  description: string,
  predicate: () => Promise<boolean>,
  timeout = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    abortController.signal.throwIfAborted();
    if (await predicate().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function waitForProcessExit(
  child: ChildProcess,
  timeout: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise<true>((resolve) => child.once('exit', () => resolve(true))),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeout)),
  ]);
}

async function gitStatus(): Promise<string> {
  const { stdout } = await exec(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: workspaceRoot },
  );
  return stdout;
}

function registerSignals(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      signalCount += 1;
      if (signalCount > 1) process.exit(signal === 'SIGINT' ? 130 : 143);
      requestedExitCode = signal === 'SIGINT' ? 130 : 143;
      abortController.abort(new Error(`Received ${signal}`));
      const child = activeChild;
      terminateProcessGroup(child, signal);
      const killTimer = setTimeout(() => {
        if (activeChild === child) terminateProcessGroup(child, 'SIGKILL');
      }, 10_000);
      killTimer.unref();
    });
  }
}

async function cleanup(
  runner: MobileRunner,
  invocation: E2EInvocation | undefined,
  baselineWorktree: string | undefined,
): Promise<void> {
  cleaningUp = true;
  let scrubError: unknown;
  try {
    await runner.releaseDevice().catch(() => undefined);
    // Appium flushes its log after wdio's onComplete, so scrub once everything is
    // written, after device cleanup so a scrub failure cannot skip it. Uploaded CI
    // artifacts must not carry Matrix ids, tokens or passwords.
    try {
      scrubDirectory(dirname(runner.artifactsDir()));
    } catch (error) {
      scrubError = error;
      console.error(
        'Artifact scrub failed; artifacts may hold identifiers',
        error,
      );
    }
  } finally {
    await invocation?.close();
  }

  if (baselineWorktree !== undefined) {
    const finalWorktree = await gitStatus();
    if (finalWorktree !== baselineWorktree) {
      throw new Error(
        `${runner.platform} E2E changed the worktree:\n${finalWorktree || '<clean>'}\n` +
          `Before the run:\n${baselineWorktree || '<clean>'}`,
      );
    }
  }
  if (scrubError) throw scrubError;
}

async function execute(runner: MobileRunner): Promise<void> {
  registerSignals();

  let invocation: E2EInvocation | undefined;
  let baselineWorktree: string | undefined;
  let failure: unknown;
  try {
    invocation = await openE2EInvocation({
      resources: runner.resources,
      workspaceRoot,
      signal: abortController.signal,
    });
    Object.assign(process.env, invocation.environment);
    baselineWorktree = await gitStatus();
    await runner.main(invocation);
  } catch (error) {
    failure = error;
  }
  try {
    await cleanup(runner, invocation, baselineWorktree);
  } catch (error) {
    failure = failure ? new AggregateError([failure, error]) : error;
  }

  if (requestedExitCode) process.exitCode = requestedExitCode;
  if (failure) throw failure;
}

/** Entry point of a platform runner script. */
export function startMobileRun(runner: MobileRunner): void {
  execute(runner).catch((error: unknown) => {
    console.error(error);
    if (!process.exitCode) process.exitCode = 1;
  });
}
