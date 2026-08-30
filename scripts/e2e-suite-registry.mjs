#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  E2E_AGGREGATE_TARGETS,
  E2E_QUARANTINE,
  E2E_SUITES,
} from '../e2e/registry/index.mts';
import { validateWorkspace } from './e2e-suite-registry-validator.mjs';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
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

export const checkPrerequisites = async (
  suites,
  {
    execute = runCommand,
    environment = process.env,
    platform = process.platform,
    fileExists = existsSync,
    fetchDiscovery = fetch,
    playwrightExists = playwrightExecutableExists,
  } = {},
) => {
  const prerequisites = new Set(
    suites.flatMap(({ prerequisites: required }) => required),
  );
  const failures = [];

  if (prerequisites.has('docker')) {
    const result = execute('docker', ['info'], { capture: true });
    if (result.status !== 0) failures.push('Docker daemon is unavailable');
  }
  if (prerequisites.has('android-avd')) {
    const adbResult = execute('adb', ['devices'], { capture: true });
    const devices = adbResult.stdout
      ?.split('\n')
      .slice(1)
      .filter((line) => /\sdevice$/.test(line));
    const requestedSerial = environment['TRINITY_ANDROID_SERIAL'];
    const hasRequestedDevice = requestedSerial
      ? devices?.some((line) => line.startsWith(`${requestedSerial}\t`))
      : devices?.some((line) => line.startsWith('emulator-'));
    const avdResult = execute('emulator', ['-list-avds'], { capture: true });
    const canStartCanonicalAvd = avdResult.stdout
      ?.split('\n')
      .includes('Trinity_API_36');
    if (
      adbResult.status !== 0 ||
      (requestedSerial
        ? !hasRequestedDevice
        : !hasRequestedDevice && !canStartCanonicalAvd)
    ) {
      failures.push(
        requestedSerial
          ? `Android device ${requestedSerial} is not ready`
          : 'no ready Android emulator or Trinity_API_36 AVD is available',
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
    execute = runCommand,
    environment = process.env,
    platform = process.platform,
    report = writeOutput,
    forwardedArgs = [],
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
  const result = execute(command, args);
  return result.status ?? 1;
};

export const runSelection = async (
  targetName,
  {
    validate = () => validateWorkspace(workspaceRoot),
    select = suitesForRun,
    preflight = checkPrerequisites,
    executeSuite = runSuite,
    reportError = writeError,
    forwardedArgs = [],
  } = {},
) => {
  const errors = validate();
  if (errors.length > 0) {
    for (const error of errors) reportError(`- ${error}`);
    reportError('Refusing to run a drifting E2E registry.');
    return 1;
  }

  const suites = select(targetName);
  const prerequisiteFailures = await preflight(suites);
  if (prerequisiteFailures.length > 0) {
    for (const failure of prerequisiteFailures) reportError(`- ${failure}`);
    reportError('E2E prerequisite preflight failed; no suites were started.');
    return 1;
  }

  for (const suite of suites) {
    const status = executeSuite(suite, { forwardedArgs });
    if (status !== 0) {
      reportError(
        `${suite.id} failed with exit code ${status}; remaining suites were not run.`,
      );
      return status;
    }
  }
  return 0;
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
