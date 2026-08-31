#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  E2E_AGGREGATE_TARGETS,
  E2E_QUARANTINE,
  E2E_SUITES,
  E2E_TIMEOUTS_MS,
} from '../e2e/registry/index.mts';
import { validateWorkspace } from './e2e-suite-registry-validator.mjs';
import { openE2EInvocation } from '../e2e/support/invocation.mts';
import {
  createProcessTerminationScope,
  runManagedCommand,
} from '../e2e/support/managed-command.mts';

export { runManagedCommand } from '../e2e/support/managed-command.mts';

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const writeOutput = (message) => process.stdout.write(`${message}\n`);
const writeError = (message) => process.stderr.write(`${message}\n`);

const runCommand = (command, args, options = {}) =>
  spawnSync(command, args, {
    cwd: workspaceRoot,
    env: { ...process.env, NX_DAEMON: 'false' },
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });

const defaultCatalog = {
  aggregates: E2E_AGGREGATE_TARGETS,
  suites: E2E_SUITES,
  quarantine: E2E_QUARANTINE,
};

export const selectSuites = (
  targetName,
  {
    aggregates = defaultCatalog.aggregates,
    suites = defaultCatalog.suites,
  } = {},
) => {
  const aggregate = aggregates.find(({ target }) => target === targetName);
  if (!aggregate) {
    throw new Error(`Unknown E2E aggregate target: ${targetName}`);
  }

  const { selection } = aggregate;
  if (selection.kind === 'all') return [...suites];
  if (selection.kind === 'environment') {
    return suites.filter(({ environment }) => environment === selection.value);
  }
  return suites.filter(({ ciTier }) => ciTier === selection.value);
};

export const quarantineApplies = (
  targetName,
  suiteId,
  {
    aggregates = defaultCatalog.aggregates,
    quarantine = defaultCatalog.quarantine,
  } = {},
) => {
  const aggregate = aggregates.find(({ target }) => target === targetName);
  if (aggregate?.selection.kind !== 'ci-tier') return false;
  return quarantine.some(
    ({ suiteId: quarantinedId, excludedTier }) =>
      quarantinedId === suiteId && excludedTier === aggregate.selection.value,
  );
};

export const suitesForRun = (
  targetName,
  {
    aggregates = defaultCatalog.aggregates,
    suites = defaultCatalog.suites,
    quarantine = defaultCatalog.quarantine,
  } = {},
) =>
  selectSuites(targetName, { aggregates, suites }).filter(
    ({ id }) => !quarantineApplies(targetName, id, { aggregates, quarantine }),
  );

const executableExists = (name, execute = runCommand) =>
  execute('sh', ['-c', 'command -v "$1"', 'sh', name], { capture: true })
    .status === 0;

const playwrightExecutableExists = async (
  engineName,
  fileExists = existsSync,
) => {
  const playwright = await import('playwright');
  return fileExists(playwright[engineName].executablePath());
};

const fileIsReadWriteAccessible = (path) => {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

export const checkPrerequisites = async (
  suites,
  {
    execute = runCommand,
    environment = process.env,
    platform = process.platform,
    fileExists = existsSync,
    fileAccessible = fileIsReadWriteAccessible,
    fetchDiscovery = fetch,
    playwrightExists = playwrightExecutableExists,
  } = {},
) => {
  const prerequisites = new Set(
    suites.flatMap(({ prerequisites: required }) => required),
  );
  const failures = [];
  const androidSdkRoot =
    environment['ANDROID_HOME'] ?? environment['ANDROID_SDK_ROOT'];
  const adbCommand = androidSdkRoot
    ? join(androidSdkRoot, 'platform-tools/adb')
    : 'adb';
  const emulatorCommand = androidSdkRoot
    ? join(androidSdkRoot, 'emulator/emulator')
    : 'emulator';

  if (prerequisites.has('docker')) {
    const result = execute('docker', ['info'], { capture: true });
    if (result.status !== 0) failures.push('Docker daemon is unavailable');
  }
  if (prerequisites.has('android-sdk')) {
    if (
      !androidSdkRoot ||
      !fileExists(adbCommand) ||
      !fileExists(emulatorCommand)
    ) {
      failures.push(
        'ANDROID_HOME or ANDROID_SDK_ROOT must contain platform-tools/adb and emulator/emulator',
      );
    }
  }
  if (prerequisites.has('java-21')) {
    const result = execute('java', ['-version'], { capture: true });
    const version = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (
      result.status !== 0 ||
      !/(?:java|openjdk) version "21(?:\.|\")/i.test(version)
    ) {
      failures.push('JDK 21 is unavailable');
    }
  }
  if (
    prerequisites.has('kvm') &&
    platform === 'linux' &&
    !fileAccessible('/dev/kvm')
  ) {
    failures.push('/dev/kvm is not read/write accessible');
  }
  if (prerequisites.has('android-avd')) {
    const adbResult = execute(adbCommand, ['devices'], { capture: true });
    const devices =
      adbResult.stdout
        ?.split('\n')
        .slice(1)
        .filter((line) => /\sdevice$/.test(line))
        .map((line) => line.split(/\s+/, 1)[0]) ?? [];
    const requestedSerial = environment['TRINITY_ANDROID_SERIAL'];
    const matchesAndroidProfile = (serial) => {
      const property = (name) => {
        const result = execute(
          adbCommand,
          ['-s', serial, 'shell', 'getprop', name],
          { capture: true },
        );
        return result.status === 0 ? result.stdout?.trim() : undefined;
      };
      return (
        property('ro.kernel.qemu') === '1' &&
        property('ro.build.version.sdk') === '36' &&
        /^(?:x86_64|amd64)$/.test(property('ro.product.cpu.abi') ?? '')
      );
    };
    const hasRequestedDevice = requestedSerial
      ? devices.includes(requestedSerial) &&
        matchesAndroidProfile(requestedSerial)
      : false;
    const canonicalDevices = requestedSerial
      ? []
      : devices.filter((serial) => {
          if (!serial.startsWith('emulator-')) return false;
          const result = execute(
            adbCommand,
            ['-s', serial, 'emu', 'avd', 'name'],
            { capture: true },
          );
          return (
            result.status === 0 &&
            result.stdout?.split(/\r?\n/, 1)[0]?.trim() === 'Trinity_API_36'
          );
        });
    const hasCanonicalDevice = canonicalDevices.some((serial) =>
      matchesAndroidProfile(serial),
    );
    const avdResult = execute(emulatorCommand, ['-list-avds'], {
      capture: true,
    });
    const canStartCanonicalAvd =
      avdResult.stdout?.split('\n').includes('Trinity_API_36') &&
      canonicalDevices.length === 0;
    if (
      adbResult.status !== 0 ||
      (requestedSerial
        ? !hasRequestedDevice
        : !hasCanonicalDevice && !canStartCanonicalAvd)
    ) {
      failures.push(
        requestedSerial
          ? `Android device ${requestedSerial} is not an online API 36 x86_64 emulator`
          : 'no validated API 36 x86_64 emulator or startable Trinity_API_36 AVD is available',
      );
    }
  }
  if (prerequisites.has('electron')) {
    const electronPackage = new URL(
      '../electron/node_modules/electron/package.json',
      import.meta.url,
    );
    if (!fileExists(electronPackage)) {
      failures.push('Electron dependencies are not installed');
    }
  }
  if (
    prerequisites.has('xvfb') &&
    platform === 'linux' &&
    !environment['DISPLAY'] &&
    !executableExists('xvfb-run', execute)
  ) {
    failures.push('xvfb-run is unavailable on headless Linux');
  }
  for (const [requirement, engine] of [
    ['playwright-chromium', 'chromium'],
    ['playwright-firefox', 'firefox'],
    ['playwright-webkit', 'webkit'],
  ]) {
    if (
      prerequisites.has(requirement) &&
      !(await playwrightExists(engine, fileExists))
    ) {
      failures.push(`${engine} is not installed for this Playwright version`);
    }
  }
  if (prerequisites.has('network')) {
    try {
      const response = await fetchDiscovery(
        'https://matrix.org/.well-known/matrix/client',
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) failures.push('matrix.org discovery is unavailable');
    } catch {
      failures.push('public network discovery is unavailable');
    }
  }

  return failures;
};

export const runSuite = (
  suite,
  {
    execute = runManagedCommand,
    environment = process.env,
    platform = process.platform,
    report = writeOutput,
    forwardedArgs = [],
    signal,
  } = {},
) => {
  const targetArgs = [
    'exec',
    'nx',
    'run',
    suite.currentTarget,
    ...(forwardedArgs.length > 0 ? ['--', ...forwardedArgs] : []),
  ];
  const needsXvfb =
    suite.prerequisites.includes('xvfb') &&
    platform === 'linux' &&
    !environment['DISPLAY'];
  const command = needsXvfb ? 'xvfb-run' : 'pnpm';
  const args = needsXvfb ? ['-a', 'pnpm', ...targetArgs] : targetArgs;

  report(`[e2e] ${suite.id} -> ${suite.currentTarget}`);
  const timeout = E2E_TIMEOUTS_MS[suite.timeoutClass];
  return Promise.resolve(
    execute(command, args, {
      timeout,
      cwd: workspaceRoot,
      environment,
      signal,
    }),
  ).then((result) => {
    if (result.timedOut) {
      report(`[e2e] ${suite.id} timed out after ${timeout} ms`);
    }
    return result.status ?? 1;
  });
};

export const runSelection = async (
  targetName,
  {
    environment = process.env,
    validate = () => validateWorkspace(workspaceRoot),
    select = suitesForRun,
    preflight = checkPrerequisites,
    executeSuite = runSuite,
    openInvocation = (resources, signal) =>
      openE2EInvocation({
        resources,
        workspaceRoot,
        environment,
        signal,
      }),
    reportError = writeError,
    forwardedArgs = [],
    createTerminationScope = createProcessTerminationScope,
  } = {},
) => {
  const termination = createTerminationScope();
  try {
    const errors = validate();
    if (errors.length > 0) {
      for (const error of errors) reportError(`- ${error}`);
      reportError('Refusing to run a drifting E2E registry.');
      return 1;
    }

    const suites = select(targetName);
    if (
      environment['TRINITY_E2E_PROTOCOL_MODE'] === 'remote' &&
      suites.some(({ environment }) => environment === 'protocol')
    ) {
      reportError(
        'Remote protocol mode is focused-only; aggregate selections are disposable-only.',
      );
      return 1;
    }
    const prerequisiteFailures = await preflight(suites);
    if (prerequisiteFailures.length > 0) {
      for (const failure of prerequisiteFailures) reportError(`- ${failure}`);
      reportError('E2E prerequisite preflight failed; no suites were started.');
      return 1;
    }

    const resources = [
      ...new Set(suites.flatMap(({ serializationKeys }) => serializationKeys)),
    ];
    const invocation = await openInvocation(resources, termination.signal);
    try {
      for (const suite of suites) {
        const status = await executeSuite(suite, {
          forwardedArgs,
          environment: invocation.environment,
          signal: termination.signal,
        });
        if (status !== 0) {
          reportError(
            `${suite.id} failed with exit code ${status}; remaining suites were not run.`,
          );
          return status;
        }
      }
      return 0;
    } finally {
      await invocation.close();
    }
  } finally {
    termination.close();
  }
};

const check = () => {
  const errors = validateWorkspace(workspaceRoot);
  if (errors.length === 0) {
    writeOutput(`E2E suite registry valid (${E2E_SUITES.length} suites).`);
    return 0;
  }
  for (const error of errors) writeError(`- ${error}`);
  writeError(`E2E suite registry failed with ${errors.length} error(s).`);
  return 1;
};

const list = (targetName) => {
  for (const { id, currentTarget, ciTier, serializationKeys } of selectSuites(
    targetName,
  )) {
    writeOutput(
      `${id}\t${currentTarget}\t${ciTier}\t${serializationKeys.join(',') || 'none'}`,
    );
  }
  return 0;
};

export const main = async (argv, { executeSelection = runSelection } = {}) => {
  const [command = 'check', targetName = 'e2e-all', ...rawForwardedArgs] = argv;
  const forwardedArgs =
    rawForwardedArgs[0] === '--' ? rawForwardedArgs.slice(1) : rawForwardedArgs;
  if (command === 'check') return check();
  if (command === 'list') return list(targetName);
  if (command === 'run') {
    return executeSelection(targetName, { forwardedArgs });
  }
  writeError(`Unknown command: ${command}`);
  return 1;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
