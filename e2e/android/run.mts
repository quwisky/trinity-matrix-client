import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_AVD,
  chooseEmulatorPort,
  parseDevices,
  parseOnlineDevices,
  reverseTarget,
  validateEmulator,
} from './device.mts';
import {
  ADB_FAILURE_LIMIT,
  ANDROID_INFRASTRUCTURE_FAILURE,
  nextAdbFailureCount,
  parseInfrastructureFailure,
  startAndroidInfrastructureWatchdog,
} from './health.mts';
import {
  openE2EInvocation,
  type E2EInvocation,
} from '../support/invocation.mts';
import { e2eArtifactPath } from '../support/playwright-config.mts';

const exec = promisify(execFile);
const workspaceRoot = join(import.meta.dirname, '../..');
const packageName = 'eu.qwky.trinity';
const driverPackages = [
  'com.microsoft.playwright.androiddriver',
  'com.microsoft.playwright.androiddriver.test',
];
const ownedEmulatorLaunchArgs = [
  '-no-window',
  '-no-audio',
  '-no-boot-anim',
  '-no-snapshot',
  '-gpu',
  'software',
  '-feature',
  '-Vulkan',
] as const;
const abortController = new AbortController();

let serial = '';
let emulatorLogFd: number | undefined;
let ownsEmulator = false;
let spawnedEmulator: ChildProcess | undefined;
let emulatorSpawnError: Error | undefined;
let emulatorExit:
  { code: number | null; signal: NodeJS.Signals | null } | undefined;
const requiredReversePorts = ['8448', '5556'] as const;
const changedReverseMappings: Array<{
  local: string;
  previous: string | undefined;
}> = [];
let playwrightAttachAttempted = false;
let activeChild: ChildProcess | undefined;
let cleanupPromise: Promise<void> | undefined;
let invocation: E2EInvocation | undefined;
let baselineWorktree: string | undefined;
let cleaningUp = false;
let requestedExitCode: number | undefined;
let signalCount = 0;
let infrastructureFailureMarker = '';
let adbFailureCount = 0;

const sdkRoot = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
if (!sdkRoot) {
  throw new Error(
    'ANDROID_HOME or ANDROID_SDK_ROOT must point at the Android SDK',
  );
}
const adb = join(sdkRoot, 'platform-tools/adb');
const emulator = join(sdkRoot, 'emulator/emulator');

const artifactsDir = (): string =>
  e2eArtifactPath(
    'trinity-e2e-android',
    'android.installed-webview',
    'host-output',
  );

function commandSignal(): AbortSignal | undefined {
  return cleaningUp ? undefined : abortController.signal;
}

async function adbRun(...args: string[]): Promise<string> {
  const { stdout } = await exec(adb, serial ? ['-s', serial, ...args] : args, {
    cwd: workspaceRoot,
    maxBuffer: 20 * 1024 * 1024,
    signal: commandSignal(),
    timeout: cleaningUp ? 15_000 : undefined,
  });
  return stdout.trim();
}

async function adbFor(target: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(adb, ['-s', target, ...args], {
    cwd: workspaceRoot,
    maxBuffer: 20 * 1024 * 1024,
    signal: commandSignal(),
    timeout: cleaningUp ? 15_000 : 10_000,
  });
  return stdout.trim();
}

function terminateProcessGroup(
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

async function inspectAndroidInfrastructure(): Promise<Error | undefined> {
  if (abortController.signal.aborted) return undefined;
  if (infrastructureFailureMarker && existsSync(infrastructureFailureMarker)) {
    try {
      const failure = parseInfrastructureFailure(
        readFileSync(infrastructureFailureMarker, 'utf8'),
      );
      return new Error(
        `${failure.kind}: ${failure.layer}: ${failure.summary}; ` +
          `diagnostics=${artifactsDir()}`,
      );
    } catch (error) {
      return new Error(
        `${ANDROID_INFRASTRUCTURE_FAILURE}: invalid fixture failure marker: ${String(error)}; ` +
          `diagnostics=${artifactsDir()}`,
      );
    }
  }
  if (emulatorSpawnError) {
    return new Error(
      `${ANDROID_INFRASTRUCTURE_FAILURE}: emulator-process: ${emulatorSpawnError.message}; ` +
        `diagnostics=${artifactsDir()}`,
    );
  }
  if (emulatorExit) {
    return new Error(
      `${ANDROID_INFRASTRUCTURE_FAILURE}: emulator-process: ${serial} exited ` +
        `with ${emulatorExit.code ?? emulatorExit.signal}; diagnostics=${artifactsDir()}`,
    );
  }

  let state: string | undefined;
  try {
    state = await adbFor(serial, 'get-state');
  } catch {
    state = undefined;
  }
  adbFailureCount = nextAdbFailureCount(adbFailureCount, state);
  if (adbFailureCount >= ADB_FAILURE_LIMIT) {
    return new Error(
      `${ANDROID_INFRASTRUCTURE_FAILURE}: transport: ${serial} failed ` +
        `${adbFailureCount} consecutive adb get-state probes; diagnostics=${artifactsDir()}`,
    );
  }
  return undefined;
}

async function run(
  command: string,
  args: string[],
  monitorAndroid = false,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    activeChild = child;
    const watchdog = monitorAndroid
      ? startAndroidInfrastructureWatchdog({
          inspect: inspectAndroidInfrastructure,
          terminate: (signal) => {
            if (activeChild === child) terminateProcessGroup(child, signal);
          },
        })
      : undefined;
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

function packageVersion(packagePath: string): string {
  const require = createRequire(import.meta.url);
  const resolved = require.resolve(`${packagePath}/package.json`);
  return (JSON.parse(readFileSync(resolved, 'utf8')) as { version: string })
    .version;
}

function assertPlaywrightVersions(): void {
  const runnerVersion = packageVersion('playwright');
  const testVersion = packageVersion('@playwright/test');
  if (runnerVersion !== testVersion) {
    throw new Error(
      `playwright (${runnerVersion}) and @playwright/test (${testVersion}) must match`,
    );
  }
}

async function gitStatus(): Promise<string> {
  const { stdout } = await exec(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: workspaceRoot },
  );
  return stdout;
}

async function assertJava21(): Promise<void> {
  const { stdout, stderr } = await exec('java', ['-version'], {
    cwd: workspaceRoot,
  });
  const version = `${stdout}\n${stderr}`;
  if (!/(?:java|openjdk) version "21(?:\.|\")/i.test(version)) {
    throw new Error(`Android E2E requires JDK 21; detected: ${version.trim()}`);
  }
}

async function adbDevicesOutput(): Promise<string> {
  const { stdout } = await exec(adb, ['devices'], {
    cwd: workspaceRoot,
    signal: commandSignal(),
  });
  return stdout;
}

async function onlineDevices(): Promise<string[]> {
  return parseOnlineDevices(await adbDevicesOutput());
}

async function runningAvdName(target: string): Promise<string> {
  const output = await adbFor(target, 'emu', 'avd', 'name');
  return output.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

async function waitUntil(
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

async function selectOrStartDevice(): Promise<void> {
  const requested = process.env['TRINITY_ANDROID_SERIAL'];
  const connectedOutput = await adbDevicesOutput();
  const connected = parseOnlineDevices(connectedOutput);
  if (requested) {
    serial = requested;
    await waitUntil(`${serial} to become online`, async () =>
      (await onlineDevices()).includes(serial),
    );
    return;
  }

  const matches: string[] = [];
  for (const candidate of connected.filter((value) =>
    value.startsWith('emulator-'),
  )) {
    if ((await runningAvdName(candidate)) === DEFAULT_AVD)
      matches.push(candidate);
  }
  if (matches.length > 1) {
    throw new Error(
      `More than one running ${DEFAULT_AVD} emulator: ${matches.join(', ')}`,
    );
  }
  if (matches[0]) {
    serial = matches[0];
    return;
  }

  const { stdout: avds } = await exec(emulator, ['-list-avds'], {
    cwd: workspaceRoot,
    signal: commandSignal(),
  });
  if (!avds.split(/\r?\n/).includes(DEFAULT_AVD)) {
    throw new Error(
      `No ${DEFAULT_AVD} AVD exists; create the API 36 x86_64 test emulator or set TRINITY_ANDROID_SERIAL`,
    );
  }

  const port = chooseEmulatorPort(
    parseDevices(connectedOutput).map(({ serial: candidate }) => candidate),
  );
  serial = `emulator-${port}`;
  const outputDirectory = artifactsDir();
  mkdirSync(outputDirectory, { recursive: true });
  emulatorLogFd = openSync(join(outputDirectory, 'emulator.log'), 'w');
  spawnedEmulator = spawn(
    emulator,
    [
      '-avd',
      DEFAULT_AVD,
      '-port',
      String(port),
      ...ownedEmulatorLaunchArgs,
    ],
    {
      cwd: workspaceRoot,
      detached: true,
      stdio: ['ignore', emulatorLogFd, emulatorLogFd],
    },
  );
  spawnedEmulator.once('error', (error) => {
    emulatorSpawnError = error;
  });
  spawnedEmulator.once('exit', (code, signal) => {
    emulatorExit = { code, signal };
  });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    abortController.signal.throwIfAborted();
    if (emulatorSpawnError) throw emulatorSpawnError;
    if (emulatorExit) {
      throw new Error(
        `${emulator} exited before ${serial} booted (${emulatorExit.code ?? emulatorExit.signal})`,
      );
    }
    if ((await onlineDevices().catch((): string[] => [])).includes(serial)) {
      const avdName = await runningAvdName(serial);
      if (avdName !== DEFAULT_AVD) {
        throw new Error(
          `${serial} reported AVD ${avdName || '<unknown>'}, expected ${DEFAULT_AVD}`,
        );
      }
      ownsEmulator = true;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Timed out waiting for owned ${DEFAULT_AVD} emulator ${serial}`,
  );
}

async function validateAndWaitForBoot(): Promise<void> {
  await waitUntil('Android boot completion', async () => {
    const complete = await adbRun('shell', 'getprop', 'sys.boot_completed');
    const bootAnimation = await adbRun('shell', 'getprop', 'init.svc.bootanim');
    return (
      complete === '1' && (bootAnimation === '' || bootAnimation === 'stopped')
    );
  });
  await waitUntil('Android package manager', async () =>
    (await adbRun('shell', 'pm', 'path', 'android')).startsWith('package:'),
  );
  await waitUntil('an active Android System WebView provider', async () => {
    const current = await adbRun(
      'shell',
      'cmd',
      'webviewupdate',
      'getCurrentWebViewPackage',
    ).catch(() => adbRun('shell', 'dumpsys', 'webviewupdate'));
    return (
      /[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+/i.test(current) &&
      !/(?:null|no webview installed|error)/i.test(current)
    );
  });
  await waitUntil('Chrome for native authentication journeys', async () =>
    (await adbRun('shell', 'pm', 'path', 'com.android.chrome')).startsWith(
      'package:',
    ),
  );
  for (const driverPackage of driverPackages) {
    const installed = await adbRun('shell', 'pm', 'path', driverPackage).catch(
      () => '',
    );
    if (installed.startsWith('package:')) {
      throw new Error(
        `${serial} already contains ${driverPackage}; remove pre-existing Playwright drivers before using this disposable test target`,
      );
    }
  }

  const properties = {
    qemu: await adbRun('shell', 'getprop', 'ro.kernel.qemu'),
    apiLevel: await adbRun('shell', 'getprop', 'ro.build.version.sdk'),
    abi: await adbRun('shell', 'getprop', 'ro.product.cpu.abi'),
  };
  const problems = validateEmulator(properties);
  if (problems.length > 0) {
    throw new Error(
      `${serial} is not the dedicated test emulator: ${problems.join('; ')}`,
    );
  }
}

async function configureReverse(): Promise<void> {
  const existing = await adbRun('reverse', '--list');
  for (const port of requiredReversePorts) {
    const local = `tcp:${port}`;
    const previous = reverseTarget(existing, local);
    if (previous === local) continue;
    await adbRun('reverse', local, local);
    changedReverseMappings.push({ local, previous });
  }
}

async function captureDiagnostics(): Promise<void> {
  if (!serial) return;
  const outputDirectory = artifactsDir();
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    join(outputDirectory, 'runner-state.json'),
    `${JSON.stringify(
      {
        serial,
        ownsEmulator,
        emulatorPid: spawnedEmulator?.pid ?? null,
        emulatorExit: emulatorExit ?? null,
        emulatorSpawnError: emulatorSpawnError?.message ?? null,
        activeChildPid: activeChild?.pid ?? null,
        ownedEmulatorLaunchArgs,
        infrastructureFailureMarker:
          infrastructureFailureMarker && existsSync(infrastructureFailureMarker)
            ? readFileSync(infrastructureFailureMarker, 'utf8')
            : null,
      },
      null,
      2,
    )}\n`,
  );

  const writeDiagnostic = async (
    file: string,
    operation: () => Promise<string>,
  ): Promise<void> => {
    try {
      writeFileSync(join(outputDirectory, file), await operation());
    } catch (error) {
      writeFileSync(join(outputDirectory, file), String(error));
    }
  };

  await writeDiagnostic('adb-devices.txt', async () => {
    const { stdout } = await exec(adb, ['devices', '-l'], {
      cwd: workspaceRoot,
      timeout: 15_000,
    });
    return stdout;
  });
  await writeDiagnostic('emulator-process.txt', async () => {
    const { stdout } = await exec(
      'ps',
      ['-eo', 'pid,ppid,stat,etime,rss,vsz,args'],
      { cwd: workspaceRoot, timeout: 15_000 },
    );
    const emulatorProcesses = stdout
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.includes(DEFAULT_AVD) ||
          (spawnedEmulator?.pid !== undefined &&
            line.trimStart().startsWith(`${spawnedEmulator.pid} `)),
      );
    return `${emulatorProcesses.join('\n') || '<no matching emulator process>'}\n`;
  });
  await writeDiagnostic('webview-final.txt', async () => {
    const [provider, appPids, primaryDriverPids, testDriverPids, sockets] =
      await Promise.all([
        adbRun(
          'shell',
          'cmd',
          'webviewupdate',
          'getCurrentWebViewPackage',
        ).catch(() => adbRun('shell', 'dumpsys', 'webviewupdate')),
        adbRun('shell', 'pidof', packageName).catch(() => '<not running>'),
        adbRun('shell', 'pidof', driverPackages[0]!).catch(
          () => '<not running>',
        ),
        adbRun('shell', 'pidof', driverPackages[1]!).catch(
          () => '<not running>',
        ),
        adbRun('shell', 'cat', '/proc/net/unix').catch(() => ''),
      ]);
    const webViewSockets = sockets
      .split(/\r?\n/)
      .filter((line) => line.includes('webview_devtools_remote'));
    return [
      `provider=${provider}`,
      `app-pids=${appPids || '<not running>'}`,
      `driver-pids=${primaryDriverPids || '<not running>'}`,
      `driver-test-pids=${testDriverPids || '<not running>'}`,
      'devtools-sockets:',
      webViewSockets.join('\n') || '<none>',
      '',
    ].join('\n');
  });
  await writeDiagnostic('graphics-final.txt', async () => {
    const properties = [
      'ro.hardware.egl',
      'ro.hardware.vulkan',
      'debug.hwui.renderer',
      'debug.renderengine.backend',
      'ro.opengles.version',
    ];
    const values = await Promise.all(
      properties.map((property) =>
        adbRun('shell', 'getprop', property).catch(() => '<unavailable>'),
      ),
    );
    return [
      `runner-args=${ownedEmulatorLaunchArgs.join(' ')}`,
      ...properties.map((property, index) => `${property}=${values[index]}`),
      '',
    ].join('\n');
  });

  const commands: Array<[string, string[]]> = [
    ['adb-get-state.txt', ['get-state']],
    ['device-properties.txt', ['shell', 'getprop']],
    ['logcat-final.txt', ['logcat', '-b', 'all', '-d']],
    ['crash-final.txt', ['logcat', '-b', 'crash', '-d']],
    ['activity-final.txt', ['shell', 'dumpsys', 'activity', 'activities']],
    ['package-final.txt', ['shell', 'dumpsys', 'package', packageName]],
    ['memory-final.txt', ['shell', 'dumpsys', 'meminfo']],
    ['surfaceflinger-final.txt', ['shell', 'dumpsys', 'SurfaceFlinger']],
  ];
  for (const [file, args] of commands) {
    await writeDiagnostic(file, () => adbRun(...args));
  }
}

async function waitForProcessExit(
  child: ChildProcess,
  timeout: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise<true>((resolve) => child.once('exit', () => resolve(true))),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeout)),
  ]);
}

async function cleanup(): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    cleaningUp = true;
    try {
      await captureDiagnostics().catch(() => undefined);
      if (serial) {
        await adbRun('shell', 'am', 'force-stop', packageName).catch(
          () => undefined,
        );
        if (playwrightAttachAttempted) {
          for (const driverPackage of driverPackages) {
            await adbRun('uninstall', driverPackage).catch(() => undefined);
          }
        }
        for (const { local, previous } of changedReverseMappings.reverse()) {
          await adbRun('reverse', '--remove', local).catch(() => undefined);
          if (previous) {
            await adbRun('reverse', local, previous).catch(() => undefined);
          }
        }
      }
      if (ownsEmulator && serial) {
        await adbRun('emu', 'kill').catch(() => undefined);
      } else if (spawnedEmulator && !emulatorExit) {
        terminateProcessGroup(spawnedEmulator, 'SIGTERM');
      }
      if (
        spawnedEmulator &&
        !(await waitForProcessExit(spawnedEmulator, 5_000))
      ) {
        terminateProcessGroup(spawnedEmulator, 'SIGKILL');
        await waitForProcessExit(spawnedEmulator, 2_000);
      }
    } finally {
      try {
        if (emulatorLogFd !== undefined) {
          closeSync(emulatorLogFd);
          emulatorLogFd = undefined;
        }
      } finally {
        await invocation?.close();
        invocation = undefined;
      }
    }

    if (baselineWorktree !== undefined) {
      const finalWorktree = await gitStatus();
      if (finalWorktree !== baselineWorktree) {
        throw new Error(
          `Android E2E changed the worktree:\n${finalWorktree || '<clean>'}\n` +
            `Before the run:\n${baselineWorktree || '<clean>'}`,
        );
      }
    }
  })();
  return cleanupPromise;
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

async function main(): Promise<void> {
  await assertJava21();
  assertPlaywrightVersions();
  await run('pnpm', ['exec', 'playwright', 'install', 'android']);
  await selectOrStartDevice();
  await validateAndWaitForBoot();
  process.env['TRINITY_E2E_PLATFORM'] = 'android';
  await run('pnpm', [
    process.env['TRINITY_E2E_PREBUILT_WWW']
      ? 'android:build:prebuilt'
      : 'android:build',
  ]);
  await run(join(workspaceRoot, 'android/gradlew'), [
    '-p',
    'android',
    'assembleSecondaryDebug',
  ]);
  await configureReverse();
  await adbRun(
    'install',
    '-r',
    '-t',
    join(workspaceRoot, 'android/app/build/outputs/apk/debug/app-debug.apk'),
  );
  await adbRun(
    'install',
    '-r',
    '-t',
    join(
      workspaceRoot,
      'android/app/build/outputs/apk/secondaryDebug/app-secondaryDebug.apk',
    ),
  );
  process.env['TRINITY_ANDROID_SERIAL'] = serial;
  const outputDirectory = artifactsDir();
  mkdirSync(outputDirectory, { recursive: true });
  infrastructureFailureMarker = join(
    outputDirectory,
    'infrastructure-failure.json',
  );
  rmSync(infrastructureFailureMarker, { force: true });
  process.env['TRINITY_ANDROID_FATAL_MARKER'] = infrastructureFailureMarker;
  playwrightAttachAttempted = true;
  await run(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      '-c',
      'e2e/android/playwright.config.mts',
      ...process.argv.slice(2),
    ],
    true,
  );
}

async function execute(): Promise<void> {
  registerSignals();

  let failure: unknown;
  try {
    invocation = await openE2EInvocation({
      resources: ['android-avd', 'synapse'],
      workspaceRoot,
      signal: abortController.signal,
    });
    Object.assign(process.env, invocation.environment);
    baselineWorktree = await gitStatus();
    await main();
  } catch (error) {
    failure = error;
  }
  try {
    await cleanup();
  } catch (error) {
    failure = failure ? new AggregateError([failure, error]) : error;
  }

  if (requestedExitCode) process.exitCode = requestedExitCode;
  if (failure) throw failure;
}

execute().catch((error: unknown) => {
  console.error(error);
  if (!process.exitCode) process.exitCode = 1;
});
