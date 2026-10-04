import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { E2EInvocation } from '../support/invocation.mts';
import { e2eArtifactPath } from '../support/playwright-config.mts';
import { MOBILE_IOS_SUITE } from '../support/host-suites.mts';
import {
  DEFAULT_IOS_DEVICE,
  DEFAULT_IOS_RUNTIME,
  parseSimulators,
  selectSimulator,
  type Simulator,
} from './simulator.mts';
import { DATA, STATE_DIR } from '../support/homeserver/paths.mjs';
import { nativePaths } from '../support/homeserver/native.mts';
import { copyHomeserverLogs } from './support/artifacts.mts';
import { APP_PACKAGE } from './support/session.mts';
import {
  commandSignal,
  isCleaningUp,
  run,
  startMobileRun,
  workspaceRoot,
} from './support/runner.mts';

const exec = promisify(execFile);
/** Where trinity-ios:build-e2e leaves the ad-hoc signed simulator app. */
const appPath = join(
  workspaceRoot,
  'dist/ios-native/DerivedData/Build/Products/Debug-iphonesimulator/App.app',
);

let simulator: Simulator | undefined;
let ownsBoot = false;

const artifactsDir = (): string =>
  e2eArtifactPath(
    MOBILE_IOS_SUITE.targetProject,
    MOBILE_IOS_SUITE.id,
    'host-output',
  );

async function simctl(...args: string[]): Promise<string> {
  const { stdout } = await exec('xcrun', ['simctl', ...args], {
    cwd: workspaceRoot,
    maxBuffer: 50 * 1024 * 1024,
    signal: commandSignal(),
    timeout: isCleaningUp() ? 30_000 : undefined,
  });
  return stdout.trim();
}

/** Use the pinned device (a booted one first), booting it only if nobody else has. */
async function selectAndBoot(): Promise<Simulator> {
  const chosen = selectSimulator(
    parseSimulators(await simctl('list', '-j', 'devices', 'available')),
    {
      device: process.env['TRINITY_IOS_DEVICE'] ?? DEFAULT_IOS_DEVICE,
      runtime: process.env['TRINITY_IOS_RUNTIME'] ?? DEFAULT_IOS_RUNTIME,
      udid: process.env['TRINITY_IOS_UDID'],
    },
  );
  simulator = chosen;
  console.log(
    `[mobile] iOS Simulator: ${chosen.name} (${chosen.runtime}) ${chosen.udid}`,
  );
  if (!chosen.booted) {
    await simctl('boot', chosen.udid);
    ownsBoot = true;
  }
  await simctl('bootstatus', chosen.udid, '-b');
  return chosen;
}

async function main(invocation: E2EInvocation): Promise<void> {
  const prebuilt = process.env['TRINITY_E2E_PREBUILT_WWW'] === '1';
  if (process.env['CI'] && !prebuilt) {
    throw new Error('iOS CI requires the verified prebuilt renderer');
  }
  const caddyRoot = invocation.descriptor.homeserver?.caddyRoot;
  if (!caddyRoot) {
    throw new Error(
      'iOS E2E needs the native homeserver runtime: set TRINITY_E2E_HOMESERVER=synapse ' +
        'and TRINITY_E2E_HOMESERVER_RUNTIME=native',
    );
  }
  const { udid } = await selectAndBoot();
  if (!prebuilt) {
    await run('pnpm', ['exec', 'nx', 'run', 'trinity:build']);
    await run(process.execPath, [
      'scripts/web-bundle-manifest.mjs',
      'write',
      'www',
    ]);
  }
  // sync-prebuilt verifies www against the manifest before and after `cap sync ios`.
  await run('pnpm', ['exec', 'nx', 'run', 'trinity-ios:build-e2e']);
  await simctl('install', udid, appPath);
  // WKWebView has no certificate-bypass hook: trust this run's Caddy CA in the Simulator.
  await simctl('keychain', udid, 'add-root-cert', caddyRoot);
  process.env['TRINITY_IOS_UDID'] = udid;
  process.env['TRINITY_IOS_APP'] = appPath;
  mkdirSync(artifactsDir(), { recursive: true });
  // Keychain access needs entitlements; keep the evidence whatever the next run does.
  // Simulator builds embed them in the Mach-O __TEXT,__entitlements section, which
  // codesign does not print, so read both.
  const inspect = async (file: string, args: string[]): Promise<string> => {
    try {
      const { stdout, stderr } = await exec(file, args, {
        signal: commandSignal(),
      });
      return stdout + stderr;
    } catch (error) {
      return String(error);
    }
  };
  writeFileSync(
    join(artifactsDir(), 'app-codesign.txt'),
    [
      '# codesign -d --entitlements :-',
      await inspect('codesign', ['-d', '--entitlements', ':-', appPath]),
      '# otool -s __TEXT __entitlements',
      await inspect('xcrun', [
        'otool',
        '-s',
        '__TEXT',
        '__entitlements',
        join(appPath, 'App'),
      ]),
    ].join('\n'),
  );
  await run(process.execPath, ['scripts/setup-appium.mjs', 'xcuitest']);
  process.env['APPIUM_HOME'] = join(workspaceRoot, '.appium');
  await run('pnpm', [
    'exec',
    'wdio',
    'run',
    'e2e/mobile/wdio.ios.conf.mts',
    ...process.argv.slice(2),
  ]);
}

async function captureDiagnostics(): Promise<void> {
  const outputDirectory = artifactsDir();
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    join(outputDirectory, 'runner-state.json'),
    `${JSON.stringify({ simulator: simulator ?? null, ownsBoot, appPath }, null, 2)}\n`,
  );
  // stop.mjs deletes ./data at teardown; the runner scrubs host-output afterwards.
  const paths = nativePaths(STATE_DIR, DATA);
  copyHomeserverLogs(
    [...Object.values(paths.logs), paths.homeserverLog],
    outputDirectory,
  );
  if (!simulator) return;
  const { udid } = simulator;
  const capture = async (file: string, args: string[]): Promise<void> => {
    try {
      writeFileSync(join(outputDirectory, file), `${await simctl(...args)}\n`);
    } catch (error) {
      writeFileSync(join(outputDirectory, file), String(error));
    }
  };
  await capture('devices.json', ['list', '-j', 'devices']);
  await capture('app-container.txt', [
    'get_app_container',
    udid,
    APP_PACKAGE,
    'data',
  ]);
  await capture('syslog-tail.txt', [
    'spawn',
    udid,
    'log',
    'show',
    '--last',
    '15m',
    '--style',
    'compact',
    '--predicate',
    'process == "App" OR process BEGINSWITH "com.apple.WebKit" OR subsystem == "com.apple.WebKit" OR subsystem == "com.apple.network"',
  ]);
}

async function releaseDevice(): Promise<void> {
  await captureDiagnostics().catch(() => undefined);
  if (!simulator) return;
  await simctl('terminate', simulator.udid, APP_PACKAGE).catch(() => undefined);
  if (ownsBoot) await simctl('shutdown', simulator.udid).catch(() => undefined);
}

startMobileRun({
  platform: 'iOS',
  resources: ['homeserver', 'ios-simulator'],
  artifactsDir,
  main,
  releaseDevice,
});
