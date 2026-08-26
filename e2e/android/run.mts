import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
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
  parseOnlineDevices,
  reverseTarget,
  validateEmulator,
} from './device.mts';
import {
  startSynapseSession,
  stopSynapseSession,
} from '../playwright/support/synapse-session.mts';

const exec = promisify(execFile);
const workspaceRoot = join(import.meta.dirname, '../..');
const artifactsDir = join(workspaceRoot, 'dist/.playwright/android');
const lockFile = join(artifactsDir, '.lock');
const packageName = 'eu.qwky.trinity';
const driverPackages = [
  'com.microsoft.playwright.androiddriver',
  'com.microsoft.playwright.androiddriver.test',
];

let serial = '';
let emulatorLogFd: number | undefined;
let ownsEmulator = false;
let ownsSynapse = false;
let previousReverse: string | undefined;
let changedReverse = false;
let activeChild: ChildProcess | undefined;
let cleanupPromise: Promise<void> | undefined;

const sdkRoot = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
if (!sdkRoot) {
  throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT must point at the Android SDK');
}
const adb = join(sdkRoot, 'platform-tools/adb');
const emulator = join(sdkRoot, 'emulator/emulator');

async function adbRun(...args: string[]): Promise<string> {
  const { stdout } = await exec(adb, serial ? ['-s', serial, ...args] : args, {
    cwd: workspaceRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

async function adbFor(target: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(adb, ['-s', target, ...args], {
    cwd: workspaceRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: 'inherit',
    });
    activeChild = child;
    child.once('error', reject);
    child.once('exit', (code, signalName) => {
      activeChild = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signalName}`));
    });
  });
}

function packageVersion(packagePath: string): string {
  const require = createRequire(import.meta.url);
  const resolved = require.resolve(`${packagePath}/package.json`);
  return (JSON.parse(readFileSync(resolved, 'utf8')) as { version: string }).version;
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

function acquireLock(): void {
  mkdirSync(artifactsDir, { recursive: true });
  try {
    writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
  } catch (error) {
    const currentPid = Number(readFileSync(lockFile, 'utf8'));
    try {
      process.kill(currentPid, 0);
    } catch {
      rmSync(lockFile, { force: true });
      writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return;
    }
    throw new Error(`Android Playwright is already running as PID ${currentPid}`, {
      cause: error,
    });
  }
}

async function onlineDevices(): Promise<string[]> {
  const { stdout } = await exec(adb, ['devices'], { cwd: workspaceRoot });
  return parseOnlineDevices(stdout);
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
    if (await predicate().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function selectOrStartDevice(): Promise<void> {
  const requested = process.env['TRINITY_ANDROID_SERIAL'];
  const connected = await onlineDevices();
  if (requested) {
    serial = requested;
    await waitUntil(`${serial} to become online`, async () =>
      (await onlineDevices()).includes(serial),
    );
    return;
  }

  const matches: string[] = [];
  for (const candidate of connected.filter((value) => value.startsWith('emulator-'))) {
    if ((await runningAvdName(candidate)) === DEFAULT_AVD) matches.push(candidate);
  }
  if (matches.length > 1) {
    throw new Error(`More than one running ${DEFAULT_AVD} emulator: ${matches.join(', ')}`);
  }
  if (matches[0]) {
    serial = matches[0];
    return;
  }

  const { stdout: avds } = await exec(emulator, ['-list-avds'], {
    cwd: workspaceRoot,
  });
  if (!avds.split(/\r?\n/).includes(DEFAULT_AVD)) {
    throw new Error(
      `No ${DEFAULT_AVD} AVD exists; create the API 36 x86_64 test emulator or set TRINITY_ANDROID_SERIAL`,
    );
  }

  const port = chooseEmulatorPort(connected);
  serial = `emulator-${port}`;
  emulatorLogFd = openSync(join(artifactsDir, 'emulator.log'), 'w');
  const child = spawn(
    emulator,
    [
      '-avd',
      DEFAULT_AVD,
      '-port',
      String(port),
      '-no-window',
      '-no-audio',
      '-no-boot-anim',
      '-gpu',
      'swiftshader_indirect',
    ],
    { cwd: workspaceRoot, detached: true, stdio: ['ignore', emulatorLogFd, emulatorLogFd] },
  );
  child.unref();
  ownsEmulator = true;
  await waitUntil(`${serial} to boot`, async () =>
    (await onlineDevices()).includes(serial),
  );
}

async function validateAndWaitForBoot(): Promise<void> {
  await waitUntil('Android boot completion', async () => {
    const complete = await adbRun('shell', 'getprop', 'sys.boot_completed');
    const bootAnimation = await adbRun('shell', 'getprop', 'init.svc.bootanim');
    return complete === '1' && (bootAnimation === '' || bootAnimation === 'stopped');
  });
  await waitUntil('Android package manager', async () =>
    (await adbRun('shell', 'pm', 'path', 'android')).startsWith('package:'),
  );
  await waitUntil('Android System WebView', async () =>
    (await adbRun('shell', 'pm', 'list', 'packages', 'com.google.android.webview')).includes(
      'com.google.android.webview',
    ),
  );

  const properties = {
    qemu: await adbRun('shell', 'getprop', 'ro.kernel.qemu'),
    apiLevel: await adbRun('shell', 'getprop', 'ro.build.version.sdk'),
    abi: await adbRun('shell', 'getprop', 'ro.product.cpu.abi'),
  };
  const problems = validateEmulator(properties);
  if (problems.length > 0) {
    throw new Error(`${serial} is not the dedicated test emulator: ${problems.join('; ')}`);
  }
}

async function configureReverse(): Promise<void> {
  previousReverse = reverseTarget(await adbRun('reverse', '--list'), 'tcp:8448');
  if (previousReverse === 'tcp:8448') return;
  await adbRun('reverse', 'tcp:8448', 'tcp:8448');
  changedReverse = true;
}

async function captureDiagnostics(): Promise<void> {
  if (!serial) return;
  mkdirSync(artifactsDir, { recursive: true });
  const commands: Array<[string, string[]]> = [
    ['device-properties.txt', ['shell', 'getprop']],
    ['logcat-final.txt', ['logcat', '-b', 'all', '-d']],
    ['activity-final.txt', ['shell', 'dumpsys', 'activity', 'activities']],
    ['package-final.txt', ['shell', 'dumpsys', 'package', packageName]],
  ];
  for (const [file, args] of commands) {
    try {
      writeFileSync(join(artifactsDir, file), await adbRun(...args));
    } catch (error) {
      writeFileSync(join(artifactsDir, file), String(error));
    }
  }
}

async function cleanup(): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await captureDiagnostics();
    if (serial) {
      await adbRun('shell', 'am', 'force-stop', packageName).catch(() => undefined);
      for (const driverPackage of driverPackages) {
        await adbRun('uninstall', driverPackage).catch(() => undefined);
      }
      if (changedReverse) {
        await adbRun('reverse', '--remove', 'tcp:8448').catch(() => undefined);
        if (previousReverse) {
          await adbRun('reverse', 'tcp:8448', previousReverse).catch(() => undefined);
        }
      }
    }
    if (ownsSynapse) await stopSynapseSession().catch(() => undefined);
    if (ownsEmulator && serial) {
      await adbRun('emu', 'kill').catch(() => undefined);
    }
    if (emulatorLogFd !== undefined) closeSync(emulatorLogFd);
    rmSync(lockFile, { force: true });
  })();
  return cleanupPromise;
}

function registerSignals(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      activeChild?.kill(signal);
      void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
    });
  }
}

async function main(): Promise<void> {
  acquireLock();
  registerSignals();
  assertPlaywrightVersions();
  await run('pnpm', ['exec', 'playwright', 'install', 'android']);
  await selectOrStartDevice();
  await validateAndWaitForBoot();
  await run('pnpm', ['android:build']);
  ownsSynapse = true;
  await startSynapseSession({ allowUnavailable: false });
  await configureReverse();
  await adbRun(
    'install',
    '-r',
    '-t',
    join(workspaceRoot, 'android/app/build/outputs/apk/debug/app-debug.apk'),
  );
  process.env['TRINITY_ANDROID_SERIAL'] = serial;
  await run('pnpm', [
    'exec',
    'playwright',
    'test',
    '-c',
    'e2e/playwright.android.config.mts',
  ]);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(cleanup);
