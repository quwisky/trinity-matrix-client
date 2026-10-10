import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
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
  startAndroidInfrastructureWatchdog,
} from './health.mts';
import { e2eArtifactPath } from '../support/playwright-config.mts';
import { MOBILE_ANDROID_SUITE } from '../support/host-suites.mts';
import { appiumLogPath } from './support/artifacts.mts';
import {
  activeChildPid,
  commandSignal,
  isCleaningUp,
  run,
  runAborted,
  startMobileRun,
  terminateProcessGroup,
  throwIfAborted,
  waitForProcessExit,
  waitUntil,
  workspaceRoot,
} from './support/runner.mts';
import {
  chromedriverFromAppiumLog,
  parseWebViewVersion,
} from './support/versions.mts';

const exec = promisify(execFile);
const packageName = 'dev.trinityproject.trinity';
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
let adbFailureCount = 0;

let androidSdk: { readonly adb: string; readonly emulator: string } | undefined;

/** Resolved on first use, so importing this runner needs no Android SDK. */
function androidTools(): { readonly adb: string; readonly emulator: string } {
  if (androidSdk) return androidSdk;
  const sdkRoot =
    process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
  if (!sdkRoot) {
    throw new Error(
      'ANDROID_HOME or ANDROID_SDK_ROOT must point at the Android SDK',
    );
  }
  androidSdk = {
    adb: join(sdkRoot, 'platform-tools/adb'),
    emulator: join(sdkRoot, 'emulator/emulator'),
  };
  return androidSdk;
}

const artifactsDir = (): string =>
  e2eArtifactPath(
    MOBILE_ANDROID_SUITE.targetProject,
    MOBILE_ANDROID_SUITE.id,
    'host-output',
  );

async function adbRun(...args: string[]): Promise<string> {
  const { stdout } = await exec(
    androidTools().adb,
    serial ? ['-s', serial, ...args] : args,
    {
      cwd: workspaceRoot,
      maxBuffer: 20 * 1024 * 1024,
      signal: commandSignal(),
      timeout: isCleaningUp() ? 15_000 : undefined,
    },
  );
  return stdout.trim();
}

async function adbFor(target: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(androidTools().adb, ['-s', target, ...args], {
    cwd: workspaceRoot,
    maxBuffer: 20 * 1024 * 1024,
    signal: commandSignal(),
    timeout: isCleaningUp() ? 15_000 : 10_000,
  });
  return stdout.trim();
}

async function inspectAndroidInfrastructure(): Promise<Error | undefined> {
  if (runAborted()) return undefined;
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

/** Fails the wdio run as soon as the emulator process or adb transport is gone. */
const androidWatchdog = (terminate: (signal: NodeJS.Signals) => void) =>
  startAndroidInfrastructureWatchdog({
    inspect: inspectAndroidInfrastructure,
    terminate,
  });

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
  const { stdout } = await exec(androidTools().adb, ['devices'], {
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

  const { stdout: avds } = await exec(androidTools().emulator, ['-list-avds'], {
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
    androidTools().emulator,
    ['-avd', DEFAULT_AVD, '-port', String(port), ...ownedEmulatorLaunchArgs],
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
    throwIfAborted();
    if (emulatorSpawnError) throw emulatorSpawnError;
    if (emulatorExit) {
      throw new Error(
        `${androidTools().emulator} exited before ${serial} booted (${emulatorExit.code ?? emulatorExit.signal})`,
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
        activeChildPid: activeChildPid() ?? null,
        ownedEmulatorLaunchArgs,
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

  await writeDiagnostic('versions.txt', async () => {
    const webview = parseWebViewVersion(
      await adbRun('shell', 'dumpsys', 'webviewupdate'),
    );
    const chromedriver = existsSync(appiumLogPath())
      ? chromedriverFromAppiumLog(readFileSync(appiumLogPath(), 'utf8'))
      : 'unknown (no Appium log)';
    const line = `[mobile] Android System WebView: ${webview}; chromedriver: ${chromedriver}`;
    console.log(line);
    return `${line}\n`;
  });
  await writeDiagnostic('adb-devices.txt', async () => {
    const { stdout } = await exec(androidTools().adb, ['devices', '-l'], {
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
    const [provider, appPids, sockets] = await Promise.all([
      adbRun('shell', 'cmd', 'webviewupdate', 'getCurrentWebViewPackage').catch(
        () => adbRun('shell', 'dumpsys', 'webviewupdate'),
      ),
      adbRun('shell', 'pidof', packageName).catch(() => '<not running>'),
      adbRun('shell', 'cat', '/proc/net/unix').catch(() => ''),
    ]);
    const webViewSockets = sockets
      .split(/\r?\n/)
      .filter((line) => line.includes('webview_devtools_remote'));
    return [
      `provider=${provider}`,
      `app-pids=${appPids || '<not running>'}`,
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

async function releaseDevice(): Promise<void> {
  try {
    await captureDiagnostics().catch(() => undefined);
    if (serial) {
      await adbRun('shell', 'am', 'force-stop', packageName).catch(
        () => undefined,
      );
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
    if (emulatorLogFd !== undefined) {
      closeSync(emulatorLogFd);
      emulatorLogFd = undefined;
    }
  }
}

async function main(): Promise<void> {
  if (process.env['CI'] && process.env['TRINITY_E2E_PREBUILT_WWW'] !== '1') {
    throw new Error('Android CI requires the verified prebuilt renderer');
  }
  await assertJava21();
  await selectOrStartDevice();
  await validateAndWaitForBoot();
  const reusePrebuiltBundle = process.env['TRINITY_E2E_PREBUILT_WWW'] === '1';
  if (reusePrebuiltBundle) {
    await run(process.execPath, [
      'scripts/web-bundle-manifest.mjs',
      'verify',
      'dist/web-bundle-manifest.json',
      'www',
    ]);
  }
  await run('pnpm', [
    reusePrebuiltBundle ? 'android:build:prebuilt' : 'android:build',
  ]);
  if (!reusePrebuiltBundle) {
    await run(process.execPath, [
      'scripts/web-bundle-manifest.mjs',
      'write',
      'www',
    ]);
  }
  await run(process.execPath, [
    'scripts/web-bundle-manifest.mjs',
    'verify-with-extras',
    'dist/web-bundle-manifest.json',
    'android/app/src/main/assets/public',
    'cordova.js',
    'cordova_plugins.js',
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
  await run(process.execPath, ['scripts/setup-appium.mjs', 'uiautomator2']);
  process.env['APPIUM_HOME'] = join(workspaceRoot, '.appium');
  await run(
    'pnpm',
    [
      'exec',
      'wdio',
      'run',
      'e2e/mobile/wdio.conf.mts',
      ...process.argv.slice(2),
    ],
    androidWatchdog,
  );
}

startMobileRun({
  platform: 'Android',
  resources: ['android-avd', 'homeserver'],
  artifactsDir,
  main,
  releaseDevice,
});
