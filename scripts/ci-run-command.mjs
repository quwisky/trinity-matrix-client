import { appendFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 2000;
const CLI_KILL_GRACE_MS = 60 * 1000;

function append(logFile, label, stream, chunk) {
  const text = chunk.toString();
  appendFileSync(logFile, `[${label}] ${stream}: ${text}`);
  for (const line of text.split(/(?<=\n)/)) {
    if (line) process.stdout.write(`[${label}] ${stream}: ${line}`);
  }
  return text;
}

function terminate(child, signal) {
  if (child.pid == null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

/** Spawn one owned process, retaining complete output and reaping its process group. */
export function runCommand({
  command,
  args = [],
  cwd = process.cwd(),
  env,
  label = basename(command),
  logDir = join(cwd, 'dist', '.ci'),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  abortSignal,
  onSpawn,
}) {
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${label.replace(/[^a-z0-9_.-]+/gi, '-')}.log`);
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = abortSignal?.aborted ?? false;
    let settled = false;
    let killTimer;
    let stopped = false;
    const stop = (reason, signal) => {
      if (stopped) return;
      stopped = true;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'abort') aborted = true;
      terminate(child, signal);
      killTimer = setTimeout(() => terminate(child, 'SIGKILL'), killGraceMs);
      killTimer.unref?.();
    };
    const cleanupGroup = () => {
      terminate(child, 'SIGTERM');
      terminate(child, 'SIGKILL');
    };
    const onAbort = () => stop('abort', 'SIGTERM');
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('timeout', 'SIGINT'), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      stdout += append(logFile, label, 'stdout', chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += append(logFile, label, 'stderr', chunk);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      abortSignal?.removeEventListener('abort', onAbort);
      appendFileSync(
        logFile,
        `[${label}] error: ${error.stack ?? error.message}\n`,
      );
      resolve({
        label,
        command,
        args,
        exitCode: null,
        signal: null,
        error,
        timedOut,
        aborted,
        stdout,
        stderr,
        logFile,
      });
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      cleanupGroup();
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolve({
        label,
        command,
        args,
        exitCode,
        signal,
        timedOut,
        aborted,
        stdout,
        stderr,
        logFile,
      });
    });
    if (abortSignal?.aborted) stop('abort', 'SIGTERM');
    onSpawn?.(child);
  });
}

export function resultExitCode(result) {
  if (result.timedOut) return 124;
  if (result.aborted) return 143;
  if (result.exitCode != null) return result.exitCode;
  return 1;
}

export function isDirectRun(meta, argv = process.argv) {
  return meta === pathToFileURL(argv[1] ?? '').href;
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args[0] !== '--timeout-ms' ||
    !Number.isFinite(Number(args[1])) ||
    Number(args[1]) <= 0 ||
    args[2] !== '--' ||
    !args[3]
  ) {
    console.error(
      'usage: node scripts/ci-run-command.mjs --timeout-ms N -- <executable> [args...]',
    );
    process.exitCode = 2;
    return;
  }
  const controller = new AbortController();
  let receivedSignal = null;
  const onSignal = (signal) => {
    receivedSignal = signal;
    controller.abort();
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
  const result = await runCommand({
    command: args[3],
    args: args.slice(4),
    label: 'suite',
    timeoutMs: Number(args[1]),
    killGraceMs: CLI_KILL_GRACE_MS,
    abortSignal: controller.signal,
  });
  const output = {
    exit_code: String(receivedSignal ? 143 : resultExitCode(result)),
    timed_out: String(result.timedOut),
    aborted: String(result.aborted),
    log_file: result.logFile,
  };
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(output))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  process.exitCode = Number(output.exit_code);
}

if (isDirectRun(import.meta.url)) await main();
