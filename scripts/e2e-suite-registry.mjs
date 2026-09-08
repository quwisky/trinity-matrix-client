#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  readFileSync,
} from 'node:fs';
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
import {
  buildAggregateReport,
  readPlaywrightSuiteSummary,
  suiteSummaryPath,
  writeAggregateReport,
} from '../e2e/support/execution-report.mts';
import {
  E2E_SAFE_COMPLETION_FILE,
  E2E_SAFE_COMPLETION_SUITE,
} from '../e2e/support/run-playwright.mts';

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
    rejectUnsafeOutcome = false,
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
    if (
      rejectUnsafeOutcome &&
      (result.error || result.signal || result.timedOut)
    ) {
      throw new Error(
        `managed suite process ended unsafely${result.timedOut ? ' (timed out)' : ''}`,
        { cause: result.error },
      );
    }
    if (result.timedOut) {
      report(`[e2e] ${suite.id} timed out after ${timeout} ms`);
    }
    return result.status ?? 1;
  });
};

const syntheticRunId = () =>
  `preflight-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

const suiteResult = (
  suite,
  outcome,
  { retries = 0, durationMs = 0, detail } = {},
) => ({
  id: suite.id,
  environment: suite.environment,
  capabilities: suite.capabilities,
  contractTypes: suite.contractTypes,
  ciTier: suite.ciTier,
  outcome,
  retries,
  durationMs,
  ...(detail ? { detail } : {}),
});

const createReportPersister =
  ({
    targetName,
    startedAt,
    now,
    writeReport,
    reportOutput,
    environment,
    reportError,
  }) =>
  (runId, results) => {
    const report = buildAggregateReport({
      target: targetName,
      runId,
      startedAt,
      finishedAt: now(),
      results,
    });
    const paths = writeReport(workspaceRoot, report);
    if (paths?.json) reportOutput(`[e2e] aggregate summary -> ${paths.json}`);
    const stepSummary = environment['GITHUB_STEP_SUMMARY'];
    if (stepSummary && paths?.markdown) {
      try {
        appendFileSync(
          stepSummary,
          `${readFileSync(paths.markdown, 'utf8')}\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportError(
          `E2E aggregate step summary could not be appended: ${message}`,
        );
      }
    }
    return report;
  };

const persistReportSafely = (persistReport, runId, results, reportError) => {
  try {
    persistReport(runId, results);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportError(`E2E aggregate summary could not be written: ${message}`);
    return 1;
  }
};

const initialSelectionResults = (aggregate, selectedSuites) => {
  if (aggregate.selection.kind !== 'ci-tier') return [];
  const selectedIds = new Set(selectedSuites.map(({ id }) => id));
  return E2E_SUITES.filter(({ id }) => !selectedIds.has(id)).map((suite) =>
    suiteResult(suite, 'skipped-by-tier'),
  );
};

const planSelectedSuites = async ({
  targetName,
  selectedSuites,
  results,
  isQuarantined,
  preflight,
  reportError,
}) => {
  const runnableSuites = [];
  const unavailableSuites = [];
  const preflightByPrerequisites = new Map();
  for (const suite of selectedSuites) {
    if (isQuarantined(targetName, suite.id)) {
      results.push(suiteResult(suite, 'quarantine'));
      continue;
    }
    const prerequisiteKey = [...suite.prerequisites].sort().join('\0');
    let failures = preflightByPrerequisites.get(prerequisiteKey);
    if (!failures) {
      failures = await preflight([suite]);
      preflightByPrerequisites.set(prerequisiteKey, failures);
    }
    if (failures.length === 0) {
      runnableSuites.push(suite);
      continue;
    }
    const detail = failures.join('; ');
    unavailableSuites.push(suite);
    results.push(suiteResult(suite, 'unavailable', { detail }));
    reportError(`[e2e] ${suite.id} unavailable: ${detail}`);
  }
  return { runnableSuites, unavailableSuites };
};

const blocksOnUnavailable = (aggregate, unavailableSuites) =>
  unavailableSuites.length > 0 &&
  (aggregate.unavailablePolicy === 'fail' ||
    unavailableSuites.some(
      ({ availabilityPolicy }) => availabilityPolicy === 'required',
    ));

const appendNotRun = (results, suites, detail) => {
  for (const suite of suites) {
    results.push(suiteResult(suite, 'not-run', { detail }));
  }
};

const readValidatedSuiteSummary = ({
  suite,
  status,
  runId,
  readSuiteResult,
}) => {
  if (!runId) return {};
  try {
    const summary = readSuiteResult(
      suiteSummaryPath(workspaceRoot, suite.targetProject, runId, suite.id),
    );
    if (summary && summary.suiteId !== suite.id) {
      return {
        summary,
        summaryFailure: `suite summary identified ${summary.suiteId}`,
      };
    }
    if (status === 0 && !summary) {
      return {
        summaryFailure: 'successful suite emitted no execution summary',
      };
    }
    if (status === 0 && summary.status !== 'passed') {
      return {
        summary,
        summaryFailure: `suite summary reported ${summary.status}`,
      };
    }
    return { summary };
  } catch (error) {
    return {
      summaryFailure: error instanceof Error ? error.message : String(error),
    };
  }
};

const readSafeCompletion = (file, suiteId, status) => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (
      parsed?.schemaVersion !== 1 ||
      parsed?.suiteId !== suiteId ||
      !Number.isInteger(parsed?.status) ||
      parsed.status < 0 ||
      parsed.status > 255 ||
      (parsed.status === 0) !== (status === 0)
    ) {
      return 'invalid scheduled suite completion record';
    }
    return undefined;
  } catch {
    return 'scheduled suite emitted no safe completion record';
  }
};

const executeRegisteredSuite = async ({
  suite,
  invocation,
  forwardedArgs,
  signal,
  rejectUnsafeOutcome = false,
  executeSuite,
  readSuiteResult,
}) => {
  const startedAt = Date.now();
  const completionFile =
    rejectUnsafeOutcome && invocation.descriptor?.artifactsRoot
      ? join(
          invocation.descriptor.artifactsRoot,
          'safe-completion',
          `${suite.id}-${randomUUID()}.json`,
        )
      : undefined;
  const status = await executeSuite(suite, {
    forwardedArgs,
    environment: completionFile
      ? {
          ...invocation.environment,
          [E2E_SAFE_COMPLETION_FILE]: completionFile,
          [E2E_SAFE_COMPLETION_SUITE]: suite.id,
        }
      : invocation.environment,
    signal,
    rejectUnsafeOutcome,
  });
  const summaryResult = readValidatedSuiteSummary({
    suite,
    status,
    runId: invocation.descriptor?.id,
    readSuiteResult,
  });
  const completionFailure = completionFile
    ? readSafeCompletion(completionFile, suite.id, status)
    : undefined;
  return {
    status,
    durationMs: Date.now() - startedAt,
    ...summaryResult,
    ...(completionFailure ? { completionFailure } : {}),
  };
};

const executeRunnableSuites = async ({
  continueAfterFailure,
  runnableSuites,
  results,
  invocation,
  forwardedArgs,
  signal,
  rejectUnsafeOutcome = false,
  executeSuite,
  readSuiteResult,
  reportError,
}) => {
  let firstFailure = 0;
  for (const [index, suite] of runnableSuites.entries()) {
    if (signal.aborted) {
      appendNotRun(
        results,
        runnableSuites.slice(index),
        'aggregate interrupted',
      );
      return 1;
    }
    let execution;
    const executionStartedAt = Date.now();
    try {
      execution = await executeRegisteredSuite({
        suite,
        invocation,
        forwardedArgs,
        signal,
        rejectUnsafeOutcome,
        executeSuite,
        readSuiteResult,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push(
        suiteResult(suite, 'failure', {
          durationMs: Date.now() - executionStartedAt,
          detail: `suite execution failed: ${message}`,
        }),
      );
      appendNotRun(
        results,
        runnableSuites.slice(index + 1),
        `stopped after ${suite.id} execution error`,
      );
      reportError(`E2E suite ${suite.id} execution failed: ${message}`);
      return 1;
    }
    const interrupted = signal.aborted;
    const failed =
      interrupted ||
      execution.status !== 0 ||
      Boolean(execution.summaryFailure) ||
      Boolean(execution.completionFailure);
    results.push(
      suiteResult(
        suite,
        failed ? 'failure' : execution.summary?.retries ? 'retry' : 'pass',
        {
          retries: execution.summary?.retries ?? 0,
          durationMs: execution.durationMs,
          ...(interrupted
            ? { detail: 'aggregate interrupted' }
            : execution.summaryFailure || execution.completionFailure
              ? {
                  detail:
                    execution.summaryFailure ?? execution.completionFailure,
                }
              : {}),
        },
      ),
    );
    if (!failed) continue;
    reportError(
      interrupted
        ? `${suite.id} interrupted; remaining suites were not run.`
        : execution.summaryFailure || execution.completionFailure
          ? `${suite.id} failed report validation: ${execution.summaryFailure ?? execution.completionFailure}`
          : `${suite.id} failed with exit code ${execution.status}`,
    );
    firstFailure ||= execution.status || 1;
    if (continueAfterFailure && !interrupted && !execution.completionFailure)
      continue;
    appendNotRun(
      results,
      runnableSuites.slice(index + 1),
      `stopped after ${suite.id}`,
    );
    return execution.status || 1;
  }
  return firstFailure;
};

const closeInvocation = async ({
  invocation,
  results,
  runnableSuites,
  reportError,
}) => {
  try {
    await invocation.close();
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = `invocation teardown failed: ${message}`;
    for (let index = results.length - 1; index >= 0; index -= 1) {
      if (runnableSuites.some(({ id }) => id === results[index].id)) {
        results[index] = { ...results[index], outcome: 'failure', detail };
        break;
      }
    }
    reportError(`E2E invocation teardown failed: ${message}`);
    return 1;
  }
};

export const runSelection = async (
  targetName,
  {
    environment = process.env,
    validate = () => validateWorkspace(workspaceRoot),
    select = selectSuites,
    isQuarantined = quarantineApplies,
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
    reportOutput = writeOutput,
    forwardedArgs = [],
    createTerminationScope = createProcessTerminationScope,
    readSuiteResult = readPlaywrightSuiteSummary,
    writeReport = writeAggregateReport,
    now = () => new Date(),
  } = {},
) => {
  const startedAt = now();
  const persistReport = createReportPersister({
    targetName,
    startedAt,
    now,
    writeReport,
    reportOutput,
    environment,
    reportError,
  });
  const termination = createTerminationScope();
  try {
    const errors = validate();
    if (errors.length > 0) {
      for (const error of errors) reportError(`- ${error}`);
      reportError('Refusing to run a drifting E2E registry.');
      return 1;
    }

    const aggregate = defaultCatalog.aggregates.find(
      ({ target }) => target === targetName,
    );
    if (!aggregate) {
      throw new Error(`Unknown E2E aggregate target: ${targetName}`);
    }
    const selectedSuites = select(targetName);
    if (
      environment['TRINITY_E2E_PROTOCOL_MODE'] === 'remote' &&
      selectedSuites.some(({ environment }) => environment === 'protocol')
    ) {
      reportError(
        'Remote protocol mode is focused-only; aggregate selections are disposable-only.',
      );
      return 1;
    }

    const results = initialSelectionResults(aggregate, selectedSuites);
    let runnableSuites;
    let unavailableSuites;
    try {
      ({ runnableSuites, unavailableSuites } = await planSelectedSuites({
        targetName,
        selectedSuites,
        results,
        isQuarantined,
        preflight,
        reportError,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const plannedIds = new Set(results.map(({ id }) => id));
      appendNotRun(
        results,
        selectedSuites.filter(({ id }) => !plannedIds.has(id)),
        `preflight failed: ${message}`,
      );
      persistReportSafely(
        persistReport,
        syntheticRunId(),
        results,
        reportError,
      );
      reportError(`E2E prerequisite preflight failed: ${message}`);
      return 1;
    }
    if (blocksOnUnavailable(aggregate, unavailableSuites)) {
      appendNotRun(
        results,
        runnableSuites,
        'required selection failed prerequisite preflight',
      );
      persistReportSafely(
        persistReport,
        syntheticRunId(),
        results,
        reportError,
      );
      reportError('E2E prerequisite preflight failed; no suites were started.');
      return 1;
    }

    if (runnableSuites.length === 0) {
      const reportStatus = persistReportSafely(
        persistReport,
        syntheticRunId(),
        results,
        reportError,
      );
      return reportStatus;
    }

    const resources = [
      ...new Set(
        runnableSuites.flatMap(({ serializationKeys }) => serializationKeys),
      ),
    ];
    let invocation;
    try {
      invocation = await openInvocation(resources, termination.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendNotRun(
        results,
        runnableSuites,
        `invocation setup failed: ${message}`,
      );
      persistReportSafely(
        persistReport,
        syntheticRunId(),
        results,
        reportError,
      );
      reportError(`E2E invocation setup failed: ${message}`);
      return 1;
    }
    const runId = invocation.descriptor?.id ?? syntheticRunId();
    if (
      targetName === 'e2e-scheduled' &&
      !invocation.descriptor?.artifactsRoot
    ) {
      appendNotRun(
        results,
        runnableSuites,
        'scheduled invocation did not provide an artifacts root',
      );
      const teardownStatus = await closeInvocation({
        invocation,
        results,
        runnableSuites,
        reportError,
      });
      const reportStatus = persistReportSafely(
        persistReport,
        runId,
        results,
        reportError,
      );
      reportError(
        'E2E scheduled invocation did not provide an artifacts root; no suites were started.',
      );
      return Math.max(1, teardownStatus, reportStatus);
    }
    let finalStatus;
    try {
      finalStatus = await executeRunnableSuites({
        continueAfterFailure: targetName === 'e2e-scheduled',
        runnableSuites,
        results,
        invocation,
        forwardedArgs,
        signal: termination.signal,
        executeSuite,
        rejectUnsafeOutcome: targetName === 'e2e-scheduled',
        readSuiteResult,
        reportError,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reportedIds = new Set(results.map(({ id }) => id));
      appendNotRun(
        results,
        runnableSuites.filter(({ id }) => !reportedIds.has(id)),
        `aggregate execution failed: ${message}`,
      );
      reportError(`E2E aggregate execution failed: ${message}`);
      finalStatus = 1;
    } finally {
      const teardownStatus = await closeInvocation({
        invocation,
        results,
        runnableSuites,
        reportError,
      });
      finalStatus ||= teardownStatus;
    }
    const reportStatus = persistReportSafely(
      persistReport,
      runId,
      results,
      reportError,
    );
    return finalStatus || reportStatus;
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
