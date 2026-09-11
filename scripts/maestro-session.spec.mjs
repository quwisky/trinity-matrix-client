import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openMaestroDevice,
  redactMaestroArtifacts,
} from '../e2e/android/maestro-session.mts';
import { writeSession } from '../e2e/support/session.mts';

const nativeSecret = 'synthetic-native-access-token';
const nativeReadSecret = 'synthetic-native-read-token';
const nativeLog =
  'V/Capacitor: callback: 42, pluginId: SecureStorage, methodName: internalSetItem, methodData: ' +
  JSON.stringify({
    prefixedKey: 'fixture.accessToken:account',
    data: JSON.stringify(nativeSecret),
    sync: false,
  }) +
  '\nV/Capacitor/Console: File:  - Line 333 - Msg: ' +
  JSON.stringify({ data: nativeReadSecret }) +
  '\nI/Capacitor: App resumed\n';

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture({ resources = ['android-avd'], rejectReverse = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'trinity-maestro-test-'));
  directories.push(root);
  const sessionFile = join(root, 'session.json');
  writeSession(sessionFile, {
    version: 1,
    id: 'maestro-test-session',
    workspaceRoot: root,
    owner: {
      pid: process.pid,
      nonce: 'test-owner-nonce',
      createdAt: new Date().toISOString(),
    },
    resources,
    endpoints: {
      application: 'http://127.0.0.1:4001',
      storybook: 'http://127.0.0.1:4002',
      report: 'http://127.0.0.1:4003',
    },
    artifactsRoot: join(root, 'artifacts'),
  });
  const calls = [];
  let closed = 0;
  const commands = {
    async run(command, args) {
      calls.push([command, ...args]);
      const operation = args.slice(args[0] === '-s' ? 2 : 0).join(' ');
      if (operation === 'devices')
        return 'List of devices attached\nemulator-5554\tdevice\n';
      if (operation === '-list-avds') return 'trinity-e2e-api36';
      if (operation === 'shell getprop sys.boot_completed') return '1';
      if (operation === 'shell pm path android')
        return 'package:/system/framework/framework-res.apk';
      if (operation === 'shell getprop ro.kernel.qemu') return '1';
      if (operation === 'shell getprop ro.build.version.sdk') return '36';
      if (operation === 'shell getprop ro.product.cpu.abi') return 'x86_64';
      if (operation === 'reverse --list')
        return 'host tcp:8448 tcp:9448\nhost tcp:5556 tcp:5556';
      if (operation === 'reverse tcp:8448 tcp:8448' && rejectReverse)
        throw new Error('reverse rejected');
      return '';
    },
    startEmulator(command, args) {
      calls.push([command, ...args]);
      return {
        assertRunning() {},
        async close() {
          closed++;
        },
      };
    },
  };
  return {
    calls,
    commands,
    closed: () => closed,
    options: {
      workspaceRoot: root,
      artifactDirectory: join(root, 'proof'),
      avd: 'trinity-e2e-api36',
      environment: {
        ANDROID_HOME: '/sdk',
        PATH: process.env.PATH,
        TRINITY_E2E_SESSION_FILE: sessionFile,
      },
    },
  };
}

function configureMaestro(
  f,
  { exitCode = 0, failScrub = false, sleepMs = 0 } = {},
) {
  const cli = join(f.options.workspaceRoot, 'maestro-fixture.mjs');
  writeFileSync(
    cli,
    `#!/usr/bin/env node
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const output = args[args.indexOf('--test-output-dir') + 1];
const password = args.find((arg) => arg.startsWith('PASSWORD='))?.slice('PASSWORD='.length) ?? '';
writeFileSync(join(output, 'commands.json'), JSON.stringify({ defineVariablesCommand: { env: { PASSWORD: password } }, evaluatedCommand: { env: { PASSWORD: password } } }));
writeFileSync(join(output, 'maestro.log'), 'login started: ' + password + '\\n');
writeFileSync(join(output, 'screenshot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
writeFileSync(join(output, 'device-logcat.txt'), ${JSON.stringify(nativeLog)});
${failScrub ? "symlinkSync('missing.json', join(output, 'broken.json'));" : ''}
writeFileSync(join(output, 'fixture-ready'), 'ready');
${sleepMs ? `await new Promise((resolve) => setTimeout(resolve, ${sleepMs}));` : ''}
process.exit(${exitCode});
`,
  );
  chmodSync(cli, 0o700);
  f.options.environment.MAESTRO_CLI = cli;
  return cli;
}

function privateArtifacts(f) {
  const root = join(f.options.workspaceRoot, 'dist/maestro-private');
  const [directory] = readdirSync(root);
  return join(root, directory);
}

async function waitForPrivateCommands(f) {
  const root = join(f.options.workspaceRoot, 'dist/maestro-private');
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (existsSync(root)) {
      const [directory] = readdirSync(root);
      if (directory) {
        const commands = join(root, directory, 'commands.json');
        if (existsSync(join(root, directory, 'fixture-ready'))) return commands;
      }
    }
    await delay(20);
  }
  throw new Error('private Maestro commands fixture was not produced');
}

describe('Maestro device ownership', () => {
  it('requires the invocation resource before touching adb', async () => {
    const f = fixture({ resources: [] });
    await expect(openMaestroDevice(f.options, f.commands)).rejects.toThrow(
      'android-avd',
    );
    expect(f.calls).toEqual([]);
  });

  it('restores borrowed reverses without stopping the emulator and releases its lease', async () => {
    const f = fixture();
    const options = { ...f.options, serial: 'emulator-5554' };
    const device = await openMaestroDevice(options, f.commands);
    await device.install('/app.apk');
    await device.close();
    await device.close();
    expect(f.closed()).toBe(0);
    expect(f.calls).toContainEqual([
      '/sdk/platform-tools/adb',
      '-s',
      'emulator-5554',
      'reverse',
      'tcp:8448',
      'tcp:9448',
    ]);
    expect(f.calls.some((call) => call.includes('--remove'))).toBe(false);
    expect(f.calls).toContainEqual([
      '/sdk/platform-tools/adb',
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'force-stop',
      'eu.qwky.trinity',
    ]);
    const next = await openMaestroDevice(options, f.commands);
    await next.close();
  });

  it('stops an owned emulator and restores forwarding after partial startup failure', async () => {
    const f = fixture({ rejectReverse: true });
    await expect(openMaestroDevice(f.options, f.commands)).rejects.toThrow(
      'reverse rejected',
    );
    expect(f.closed()).toBe(1);
    expect(f.calls).toContainEqual([
      '/sdk/platform-tools/adb',
      '-s',
      'emulator-5556',
      'reverse',
      'tcp:8448',
      'tcp:9448',
    ]);
    expect(f.calls.some((call) => call.includes('-read-only'))).toBe(true);
  });

  it('closes the owned emulator when its lifetime is cancelled', async () => {
    const f = fixture();
    const controller = new AbortController();
    const device = await openMaestroDevice(
      { ...f.options, signal: controller.signal },
      f.commands,
    );
    controller.abort();
    await device.close();
    expect(f.closed()).toBe(1);
  });

  it('stops every declared installed app after cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    const device = await openMaestroDevice(
      { ...f.options, signal: controller.signal },
      f.commands,
    );
    await device.install('/primary.apk');
    await device.install('/secondary.apk', 'eu.qwky.trinity.secondary');
    controller.abort(new Error('test cancellation'));
    await device.close();

    expect(f.closed()).toBe(1);
    expect(f.calls).toContainEqual([
      '/sdk/platform-tools/adb',
      '-s',
      'emulator-5556',
      'shell',
      'am',
      'force-stop',
      'eu.qwky.trinity',
    ]);
    expect(f.calls).toContainEqual([
      '/sdk/platform-tools/adb',
      '-s',
      'emulator-5556',
      'shell',
      'am',
      'force-stop',
      'eu.qwky.trinity.secondary',
    ]);
    expect(f.calls).toContainEqual([
      '/sdk/platform-tools/adb',
      '-s',
      'emulator-5556',
      'reverse',
      'tcp:8448',
      'tcp:9448',
    ]);
  });

  it('bounds unresponsive ADB diagnostics before terminating the emulator', async () => {
    const f = fixture();
    const commands = {
      ...f.commands,
      async run(command, args, options) {
        if (args.includes('logcat') || args.includes('dumpsys')) {
          expect(options.timeout).toBe(2_000);
          return new Promise((_, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(options.signal.reason),
              { once: true },
            );
          });
        }
        return f.commands.run(command, args);
      },
    };
    const device = await openMaestroDevice(f.options, commands);
    const started = Date.now();
    await device.close();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(f.closed()).toBe(1);
  });

  it('redacts secret variables from JSON and text artifacts without changing PNG bytes', async () => {
    const f = fixture();
    const output = join(f.options.artifactDirectory, 'redaction');
    const password = 'quoted "secret"\\value';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(output, 'commands.json'),
      JSON.stringify({
        defineVariablesCommand: { env: { PASSWORD: password } },
        evaluatedCommand: { env: { PASSWORD: password } },
      }),
    );
    writeFileSync(join(output, 'maestro.log'), `login started: ${password}\n`);
    writeFileSync(join(output, 'screenshot.png'), png);

    await redactMaestroArtifacts(output, {
      PASSWORD: password,
      HOMESERVER: 'https://example.test',
    });

    const commands = JSON.parse(
      readFileSync(join(output, 'commands.json'), 'utf8'),
    );
    expect(commands.defineVariablesCommand.env.PASSWORD).toBe('[REDACTED]');
    expect(commands.evaluatedCommand.env.PASSWORD).toBe('[REDACTED]');
    expect(readFileSync(join(output, 'maestro.log'), 'utf8')).toBe(
      'login started: [REDACTED]\n',
    );
    expect(readFileSync(join(output, 'screenshot.png'))).toEqual(png);
  });

  it('redacts native secrets before publishing a flow without secret variables', async () => {
    const f = fixture();
    configureMaestro(f);
    const device = await openMaestroDevice(
      { ...f.options, serial: 'emulator-5554' },
      f.commands,
    );

    await device.runFlow('/flows/read.yaml');
    const [output] = readdirSync(f.options.artifactDirectory);
    const log = readFileSync(
      join(f.options.artifactDirectory, output, 'device-logcat.txt'),
      'utf8',
    );
    expect(log).not.toContain(nativeSecret);
    expect(log).not.toContain(nativeReadSecret);
    expect(log).toContain('Msg: [REDACTED]');
    expect(log).toContain('methodData: [REDACTED]');
    expect(log).toContain('App resumed');
    await device.close();
  });

  it('redacts native secrets in final device diagnostics', async () => {
    const f = fixture();
    const run = f.commands.run;
    f.commands.run = async (command, args) => {
      const result = await run(command, args);
      return args.includes('logcat') ? nativeLog : result;
    };
    const device = await openMaestroDevice(
      { ...f.options, serial: 'emulator-5554' },
      f.commands,
    );

    await device.close();
    const log = readFileSync(
      join(f.options.artifactDirectory, 'logcat.txt'),
      'utf8',
    );
    expect(log).not.toContain(nativeSecret);
    expect(log).not.toContain(nativeReadSecret);
    expect(log).toContain('Msg: [REDACTED]');
    expect(log).toContain('methodData: [REDACTED]');
    expect(log).toContain('App resumed');
  });

  it('keeps raw artifacts private when redaction fails', async () => {
    const f = fixture();
    configureMaestro(f, { failScrub: true });
    const device = await openMaestroDevice(
      { ...f.options, serial: 'emulator-5554' },
      f.commands,
    );

    await expect(
      device.runFlow('/flows/login.yaml', { PASSWORD: 'scrub-secret' }),
    ).rejects.toThrow('redaction failed');
    expect(
      readdirSync(f.options.artifactDirectory).filter((name) =>
        name.startsWith('login-'),
      ),
    ).toHaveLength(0);
    expect(
      statSync(join(f.options.workspaceRoot, 'dist/maestro-private')).mode &
        0o777,
    ).toBe(0o700);
    expect(
      readFileSync(join(privateArtifacts(f), 'commands.json'), 'utf8'),
    ).toContain('scrub-secret');
    await device.close();
  });

  it('publishes redacted reports before reporting a failed Maestro command', async () => {
    const f = fixture();
    configureMaestro(f, { exitCode: 7 });
    const device = await openMaestroDevice(
      { ...f.options, serial: 'emulator-5554' },
      f.commands,
    );

    await expect(
      device.runFlow('/flows/login.yaml', { PASSWORD: 'command-secret' }),
    ).rejects.toThrow('failed (7)');
    const [output] = readdirSync(f.options.artifactDirectory);
    const commands = readFileSync(
      join(f.options.artifactDirectory, output, 'commands.json'),
      'utf8',
    );
    expect(commands).not.toContain('command-secret');
    expect(commands).toContain('[REDACTED]');
    await device.close();
  });

  it('keeps cancelled command output private when scrubbing fails', async () => {
    const f = fixture();
    configureMaestro(f, { failScrub: true, sleepMs: 5_000 });
    const controller = new AbortController();
    const device = await openMaestroDevice(
      { ...f.options, serial: 'emulator-5554', signal: controller.signal },
      f.commands,
    );
    const run = device.runFlow('/flows/login.yaml', {
      PASSWORD: 'cancel-secret',
    });
    const privateCommands = await waitForPrivateCommands(f);
    controller.abort(new Error('test cancellation'));

    await expect(run).rejects.toThrow('redaction failed');
    expect(
      readdirSync(f.options.artifactDirectory).filter((name) =>
        name.startsWith('login-'),
      ),
    ).toHaveLength(0);
    expect(readFileSync(privateCommands, 'utf8')).toContain('cancel-secret');
    await device.close();
  });

  it('fails a boot deadline and releases the same serial for the next run', async () => {
    const f = fixture();
    await expect(
      openMaestroDevice({ ...f.options, bootTimeoutMs: 0 }, f.commands),
    ).rejects.toThrow('Timed out');
    expect(f.closed()).toBe(1);
    const next = await openMaestroDevice(f.options, f.commands);
    expect(next.serial).toBe('emulator-5556');
    await next.close();
    expect(f.closed()).toBe(2);
  });
});
