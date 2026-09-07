#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, sep } from 'node:path';
import { createProcessTerminationScope } from '../e2e/support/managed-command.mts';
import { isDirectRun, resultExitCode, runCommand } from './ci-run-command.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIAGNOSTIC_ROOT_PATTERN = /^dist[\\/]ios-native[\\/]run\.[^/\\]+$/u;
const requiredSettings = ['SDKROOT', 'CONFIGURATION', 'CODE_SIGNING_ALLOWED'];
const TOOLCHAIN_TIMEOUT_MS = 60_000;
const SETTINGS_TIMEOUT_MS = 120_000;
const DEFAULT_BUILD_TIMEOUT_MS = 18 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 30_000;

const gitSha = (root) => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
};
const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const isRegular = (path) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};
const isDirectory = (path) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};
const hasRegularFiles = (path) => {
  if (isRegular(path)) return statSync(path).size > 0;
  if (!isDirectory(path)) return false;
  return readdirSync(path, { withFileTypes: true }).some((entry) => {
    const child = join(path, entry.name);
    return entry.isFile()
      ? statSync(child).size > 0
      : entry.isDirectory() && hasRegularFiles(child);
  });
};
const outputOf = (result) => `${result?.stdout ?? ''}${result?.stderr ?? ''}`;

export function diagnosticRootIsSafe(root, workspaceRoot = ROOT) {
  const absoluteRoot = resolve(root ?? '');
  const relativeRoot = relative(resolve(workspaceRoot), absoluteRoot);
  return (
    DIAGNOSTIC_ROOT_PATTERN.test(relativeRoot) &&
    !relativeRoot.startsWith(`..${sep}`) &&
    !relativeRoot.includes(`${sep}..${sep}`)
  );
}

function settingsValues(settings) {
  if (!Array.isArray(settings)) return settings?.buildSettings ?? {};
  return settings.reduce(
    (values, entry) => Object.assign(values, entry?.buildSettings ?? {}),
    {},
  );
}

export function validateDiagnostics(
  root,
  { workspaceRoot = ROOT, expectedSha = gitSha(workspaceRoot) } = {},
) {
  const errors = [];
  const resolvedRoot = resolve(root ?? '');
  if (
    !root ||
    !diagnosticRootIsSafe(resolvedRoot, workspaceRoot) ||
    !isDirectory(resolvedRoot)
  )
    errors.push('diagnostic root must be a dist/ios-native/run.* directory');
  const files = {
    log: join(resolvedRoot, 'xcodebuild.log'),
    toolchain: join(resolvedRoot, 'toolchain.txt'),
    settings: join(resolvedRoot, 'build-settings.json'),
    execution: join(resolvedRoot, 'execution.json'),
    result: join(resolvedRoot, 'build.xcresult'),
  };
  for (const [name, path] of Object.entries(files))
    if (!hasRegularFiles(path)) errors.push(`missing iOS diagnostic: ${name}`);
  let execution;
  if (isRegular(files.settings)) {
    try {
      const values = settingsValues(
        JSON.parse(readFileSync(files.settings, 'utf8')),
      );
      for (const key of requiredSettings)
        if (typeof values[key] !== 'string' || values[key].length === 0)
          errors.push(`iOS build settings missing ${key}`);
      if (values.CODE_SIGNING_ALLOWED !== 'NO')
        errors.push('iOS build settings must disable code signing');
    } catch {
      errors.push('malformed iOS diagnostic: settings');
    }
  }
  if (isRegular(files.execution)) {
    try {
      execution = JSON.parse(readFileSync(files.execution, 'utf8'));
      const valid =
        typeof execution.checkoutSha === 'string' &&
        /^[0-9a-f]{40}$/u.test(execution.checkoutSha) &&
        typeof execution.compilerStarted === 'boolean' &&
        typeof execution.phase === 'string' &&
        Array.isArray(execution.args) &&
        execution.args.every((arg) => typeof arg === 'string') &&
        Number.isInteger(execution.exitCode) &&
        typeof execution.timedOut === 'boolean' &&
        typeof execution.aborted === 'boolean';
      if (!valid) errors.push('malformed iOS diagnostic: execution');
      if (expectedSha && execution.checkoutSha !== expectedSha)
        errors.push('iOS diagnostics checkout SHA does not match expected SHA');
      if (!execution.compilerStarted)
        errors.push('iOS diagnostics do not prove compiler execution started');
      if (execution.exitCode !== 0 || execution.timedOut || execution.aborted)
        errors.push('iOS compiler execution failed or timed out');
      if (execution.compilerStarted && !hasRegularFiles(files.result))
        errors.push('missing iOS diagnostic: result');
    } catch {
      errors.push('malformed iOS diagnostic: execution');
    }
  }
  return { ok: errors.length === 0, errors, files, execution };
}

export async function buildNative({
  root = ROOT,
  run = runCommand,
  command = 'xcodebuild',
  timeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  environment = process.env,
  abortSignal,
  runId = `run.${Date.now()}-${randomUUID().slice(0, 12)}`,
} = {}) {
  const workspaceRoot = resolve(root);
  const probeTimeoutMs = Number(environment.PROBE_582_TIMEOUT_MS);
  const compilerTimeoutMs =
    Number.isFinite(probeTimeoutMs) && probeTimeoutMs > 0
      ? probeTimeoutMs
      : timeoutMs;
  if (compilerTimeoutMs !== timeoutMs)
    console.error(
      `[probe] deliberate iOS compiler timeout: ${compilerTimeoutMs} ms`,
    );
  const iosRoot = join(workspaceRoot, 'ios');
  const diagnosticRoot = join(workspaceRoot, 'dist', 'ios-native', runId);
  const derivedDataRoot = join(
    workspaceRoot,
    'dist',
    'ios-native',
    'DerivedData',
    runId,
  );
  mkdirSync(diagnosticRoot, { recursive: true });
  mkdirSync(derivedDataRoot, { recursive: true });
  if (environment.GITHUB_OUTPUT)
    appendFileSync(
      environment.GITHUB_OUTPUT,
      `diagnostic-root=${diagnosticRoot}\n`,
    );
  const sha = gitSha(workspaceRoot);
  const expectedSha = environment.CI_IOS_SHA;
  const startedAt = new Date().toISOString();
  const initialExecution = {
    checkoutSha: sha,
    expectedSha: expectedSha ?? null,
    compilerStarted: false,
    phase: 'checkout',
    startedAt,
    finishedAt: null,
    exitCode: 1,
    timedOut: false,
    aborted: false,
    command,
    args: [],
  };
  writeJson(join(diagnosticRoot, 'execution.json'), initialExecution);
  if (
    !/^[0-9a-f]{40}$/.test(sha ?? '') ||
    (expectedSha && expectedSha !== sha)
  ) {
    writeFileSync(
      join(diagnosticRoot, 'xcodebuild.log'),
      'iOS checkout SHA does not match the expected full SHA\n',
    );
    return { diagnosticRoot, execution: initialExecution, exitCode: 1 };
  }
  // Every command has its own process group. Forward cancellation explicitly and
  // wait for that group before persisting final evidence or starting another phase.
  const executePhase = async (options) => {
    if (abortSignal?.aborted)
      return {
        ...options,
        exitCode: 143,
        aborted: true,
        stdout: '',
        stderr: 'Phase skipped after cancellation\n',
      };
    try {
      return await run({ ...options, abortSignal });
    } catch (error) {
      return { ...options, exitCode: 1, stdout: '', stderr: String(error) };
    }
  };
  const toolchain = await executePhase({
    command,
    args: ['-version'],
    cwd: workspaceRoot,
    label: 'ios-toolchain',
    logDir: diagnosticRoot,
    timeoutMs: Math.min(timeoutMs, TOOLCHAIN_TIMEOUT_MS),
    killGraceMs,
    env: environment,
  });
  const sdk = await executePhase({
    command: 'xcrun',
    args: ['--sdk', 'iphonesimulator', '--show-sdk-version'],
    cwd: workspaceRoot,
    label: 'ios-sdk',
    logDir: diagnosticRoot,
    timeoutMs: Math.min(timeoutMs, TOOLCHAIN_TIMEOUT_MS),
    killGraceMs,
    env: environment,
  });
  writeFileSync(
    join(diagnosticRoot, 'toolchain.txt'),
    `xcodebuild -version\n${outputOf(toolchain)}xcrun --sdk iphonesimulator --show-sdk-version\n${outputOf(sdk)}`,
  );
  const settingsArgs = [
    '-project',
    'App/App.xcodeproj',
    '-scheme',
    'App',
    '-sdk',
    'iphonesimulator',
    '-configuration',
    'Debug',
    '-showBuildSettings',
    '-json',
    'CODE_SIGNING_ALLOWED=NO',
  ];
  const settings = await executePhase({
    command,
    cwd: iosRoot,
    label: 'ios-build-settings',
    logDir: diagnosticRoot,
    timeoutMs: Math.min(timeoutMs, SETTINGS_TIMEOUT_MS),
    killGraceMs,
    args: settingsArgs,
    env: environment,
  });
  let parsedSettings;
  try {
    parsedSettings = JSON.parse(settings.stdout ?? '');
  } catch {
    parsedSettings = {
      raw: outputOf(settings),
      error: 'invalid xcodebuild settings JSON',
    };
  }
  writeJson(join(diagnosticRoot, 'build-settings.json'), parsedSettings);
  const values = settingsValues(parsedSettings);
  const settingsValid =
    requiredSettings.every(
      (key) => typeof values[key] === 'string' && values[key].length > 0,
    ) && values.CODE_SIGNING_ALLOWED === 'NO';
  const prerequisite =
    resultExitCode(toolchain) === 0 &&
    resultExitCode(sdk) === 0 &&
    resultExitCode(settings) === 0 &&
    settingsValid;
  let build = {
    stdout: '',
    stderr: '',
    exitCode: prerequisite
      ? 1
      : resultExitCode(toolchain) ||
        resultExitCode(sdk) ||
        resultExitCode(settings) ||
        1,
  };
  const resultBundle = join(diagnosticRoot, 'build.xcresult');
  const args = [
    '-project',
    'App/App.xcodeproj',
    '-scheme',
    'App',
    '-sdk',
    'iphonesimulator',
    '-configuration',
    'Debug',
    '-derivedDataPath',
    derivedDataRoot,
    '-resultBundlePath',
    resultBundle,
    'build',
    'CODE_SIGNING_ALLOWED=NO',
  ];
  let compilerStarted = false;
  if (prerequisite)
    build = await executePhase({
      command,
      args,
      cwd: iosRoot,
      label: 'ios-build',
      logDir: diagnosticRoot,
      timeoutMs: compilerTimeoutMs,
      killGraceMs,
      env: environment,
      onSpawn: (child) => {
        compilerStarted = child.pid != null;
      },
    });
  writeFileSync(
    join(diagnosticRoot, 'xcodebuild.log'),
    outputOf(build) ||
      outputOf(settings) ||
      outputOf(toolchain) ||
      outputOf(sdk),
  );
  const execution = {
    checkoutSha: sha,
    expectedSha: expectedSha ?? null,
    compilerStarted,
    phase: compilerStarted
      ? 'build'
      : resultExitCode(toolchain) !== 0 || resultExitCode(sdk) !== 0
        ? 'toolchain'
        : 'settings',
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: resultExitCode(build),
    timedOut: Boolean(
      build.timedOut || toolchain.timedOut || sdk.timedOut || settings.timedOut,
    ),
    aborted: Boolean(
      abortSignal?.aborted ||
      build.aborted ||
      toolchain.aborted ||
      sdk.aborted ||
      settings.aborted,
    ),
    command,
    args,
  };
  if (execution.aborted) execution.exitCode = 143;
  writeJson(join(diagnosticRoot, 'execution.json'), execution);
  return { ...build, diagnosticRoot, execution, exitCode: execution.exitCode };
}

if (isDirectRun(import.meta.url, process.argv)) {
  const command = process.argv[2];
  if (command === 'validate-diagnostics') {
    const result = validateDiagnostics(process.env.CI_IOS_DIAGNOSTICS_ROOT, {
      expectedSha: process.env.CI_IOS_SHA || gitSha(ROOT),
    });
    if (!result.ok) console.error(result.errors.join('\n'));
    process.exitCode = result.ok ? 0 : 1;
  } else if (command === 'build') {
    const termination = createProcessTerminationScope();
    try {
      process.exitCode = (
        await buildNative({ abortSignal: termination.signal })
      ).exitCode;
    } finally {
      termination.close();
    }
  } else {
    console.error('usage: ios-native-build.mjs <build|validate-diagnostics>');
    process.exitCode = 2;
  }
}
