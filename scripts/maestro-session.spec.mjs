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
  nativeStorageMethodDataIsRedacted,
  openMaestroDevice,
  redactMaestroArtifacts,
} from '../e2e/android/maestro-session.mts';
import { writeSession } from '../e2e/support/session.mts';
import { pickAndroidDocument } from '../e2e/android/maestro-document-picker.mts';

const nativeSecret = 'synthetic-native-access-token';
const nativeReadSecret = 'synthetic-native-read-token';
const nativePreferenceSecret = 'synthetic draft prefix';
const nativeLog =
  'V/Capacitor: callback: 42, pluginId: SecureStorage, methodName: internalSetItem, methodData: ' +
  JSON.stringify({
    prefixedKey: 'fixture.accessToken:account',
    data: JSON.stringify(nativeSecret),
    sync: false,
  }) +
  '\nV/Capacitor: callback: 43, pluginId: Preferences, methodName: set, methodData: ' +
  JSON.stringify({
    key: 'trinity.composer.drafts',
    value: JSON.stringify({ conversation: nativePreferenceSecret }),
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
      if (
        operation ===
        'shell cat /proc/sys/net/ipv4/ip_local_port_range /proc/net/tcp /proc/net/tcp6'
      )
        return '32768 60999\nsl local_address rem_address st\nsl local_address remote_address st\n';
      if (operation.startsWith('shell pm clear ')) return 'Success';
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

function fontScaleCommands(f, { initial = '1.0', onSetting } = {}) {
  const state = { value: initial, operations: [], options: [] };
  const commands = {
    ...f.commands,
    async run(command, args, options) {
      const operation = args.slice(args[0] === '-s' ? 2 : 0).join(' ');
      if (!operation.startsWith('shell settings '))
        return f.commands.run(command, args, options);
      state.operations.push(operation);
      state.options.push(options);
      const override = await onSetting?.(operation, state);
      if (override !== undefined) return override;
      if (operation === 'shell settings get system font_scale')
        return state.value ?? 'null';
      if (operation === 'shell settings delete system font_scale') {
        state.value = null;
        return 'Deleted 1 rows';
      }
      const prefix = 'shell settings put system font_scale ';
      if (operation.startsWith(prefix)) {
        state.value = operation.slice(prefix.length);
        return '';
      }
      throw new Error(`Unexpected settings operation: ${operation}`);
    },
  };
  return { state, commands };
}

function configureMaestro(
  f,
  { driverPortFailures = 0, exitCode = 0, failScrub = false, sleepMs = 0 } = {},
) {
  const cli = join(f.options.workspaceRoot, 'maestro-fixture.mjs');
  writeFileSync(
    cli,
    `#!/usr/bin/env node
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const output = args[args.indexOf('--test-output-dir') + 1];
const driverPort = args[args.indexOf('--driver-host-port') + 1];
const attemptsFile = join(process.cwd(), 'maestro-driver-port-attempts.json');
const attempts = existsSync(attemptsFile) ? JSON.parse(readFileSync(attemptsFile, 'utf8')) : [];
attempts.push(driverPort);
writeFileSync(attemptsFile, JSON.stringify(attempts));
${driverPortFailures ? `if (attempts.length <= ${driverPortFailures}) { console.error('Requested driver host port ' + driverPort + ' is not available'); process.exit(1); }` : ''}
const password = args.find((arg) => arg.startsWith('PASSWORD='))?.slice('PASSWORD='.length) ?? '';
writeFileSync(join(output, 'commands.json'), JSON.stringify({ cliArgs: args, defineVariablesCommand: { env: { PASSWORD: password } }, evaluatedCommand: { env: { PASSWORD: password } } }));
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
  it('restores the exact prior font scale idempotently before owned emulator teardown', async () => {
    const f = fixture();
    const { state, commands } = fontScaleCommands(f);
    const device = await openMaestroDevice(f.options, commands);
    const lease = await device.setFontScale('1.5');
    expect(lease.previous).toBe('1.0');
    expect(lease.applied).toBe('1.5');
    expect(state.value).toBe('1.5');
    await lease.restore();
    await lease.restore();
    await device.close();
    expect(state.value).toBe('1.0');
    expect(state.operations).toEqual([
      'shell settings get system font_scale',
      'shell settings put system font_scale 1.5',
      'shell settings get system font_scale',
      'shell settings put system font_scale 1.0',
      'shell settings get system font_scale',
    ]);
    expect(f.closed()).toBe(1);
  });

  it('waits for an in-flight font write and deletes an absent setting after cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    let writeStarted;
    let releaseWrite;
    const started = new Promise((resolve) => {
      writeStarted = resolve;
    });
    const gate = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const { state, commands } = fontScaleCommands(f, {
      initial: null,
      async onSetting(operation) {
        if (operation === 'shell settings put system font_scale 1.5') {
          writeStarted();
          await gate;
        }
      },
    });
    const device = await openMaestroDevice(
      { ...f.options, signal: controller.signal },
      commands,
    );
    const applying = device.setFontScale('1.5');
    await started;
    controller.abort(new Error('font write cancelled'));
    const closing = device.close();
    releaseWrite();
    await Promise.allSettled([applying, closing]);
    expect(state.value).toBeNull();
    expect(state.operations).toContain(
      'shell settings delete system font_scale',
    );
    expect(
      state.operations.indexOf('shell settings delete system font_scale'),
    ).toBeGreaterThan(
      state.operations.indexOf('shell settings put system font_scale 1.5'),
    );
    expect(
      state.options.every(
        (entry) =>
          entry.timeout === 2_000 &&
          entry.signal !== controller.signal &&
          !entry.signal.aborted,
      ),
    ).toBe(true);
    expect(f.closed()).toBe(1);
  });

  it('retries a failed explicit font restore when the device closes', async () => {
    const f = fixture();
    let failuresRemaining = 1;
    const { state, commands } = fontScaleCommands(f, {
      onSetting(operation) {
        if (
          operation === 'shell settings put system font_scale 1.0' &&
          failuresRemaining-- > 0
        )
          throw new Error('restore rejected once');
      },
    });
    const device = await openMaestroDevice(f.options, commands);
    const lease = await device.setFontScale('1.5');
    await expect(lease.restore()).rejects.toThrow('restore rejected once');
    expect(state.value).toBe('1.5');
    await device.close();
    expect(state.value).toBe('1.0');
    expect(
      state.operations.filter(
        (operation) => operation === 'shell settings put system font_scale 1.0',
      ),
    ).toHaveLength(2);
  });

  it('rejects a font write readback mismatch and restores the saved value', async () => {
    const f = fixture();
    let reads = 0;
    const { state, commands } = fontScaleCommands(f, {
      onSetting(operation) {
        if (
          operation === 'shell settings get system font_scale' &&
          ++reads === 2
        )
          return 'not-applied';
      },
    });
    const device = await openMaestroDevice(f.options, commands);
    await expect(device.setFontScale('1.5')).rejects.toThrow();
    expect(state.value).toBe('1.0');
    await device.close();
  });

  it('restores font scale while releasing a borrowed emulator without stopping it', async () => {
    const f = fixture();
    const { state, commands } = fontScaleCommands(f, { initial: null });
    const device = await openMaestroDevice(
      { ...f.options, serial: 'emulator-5554' },
      commands,
    );
    await device.setFontScale('1.5');
    await device.close();
    expect(state.value).toBeNull();
    expect(f.closed()).toBe(0);
  });

  it('distinguishes exact redacted native storage payloads from raw values', () => {
    expect(
      nativeStorageMethodDataIsRedacted(
        'V/Capacitor: pluginId: Preferences, methodName: set, methodData: [REDACTED]\n',
        'Preferences',
      ),
    ).toBe(true);
    expect(
      nativeStorageMethodDataIsRedacted(
        'V/Capacitor: pluginId: Preferences, methodName: set, methodData: {"value":"draft prefix"}\n',
        'Preferences',
      ),
    ).toBe(false);
  });

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

  it('stops and clears every declared installed app after cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    const cleanupOptions = [];
    const commands = {
      ...f.commands,
      async run(command, args, options) {
        const operation = args.slice(args[0] === '-s' ? 2 : 0).join(' ');
        if (operation === 'shell am force-stop eu.qwky.trinity') {
          f.calls.push([command, ...args]);
          cleanupOptions.push(options);
          throw new Error('primary force-stop failed');
        }
        if (operation.startsWith('shell pm clear ')) {
          f.calls.push([command, ...args]);
          cleanupOptions.push(options);
          return 'Success';
        }
        return f.commands.run(command, args, options);
      },
    };
    const device = await openMaestroDevice(
      { ...f.options, signal: controller.signal },
      commands,
    );
    await device.install('/primary.apk');
    await device.install('/secondary.apk', 'eu.qwky.trinity.secondary');
    controller.abort(new Error('test cancellation'));
    await expect(device.close()).rejects.toThrow(
      'Android emulator-5556 cleanup failed',
    );

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
      'shell',
      'pm',
      'clear',
      'eu.qwky.trinity',
    ]);
    expect(f.calls).toContainEqual([
      '/sdk/platform-tools/adb',
      '-s',
      'emulator-5556',
      'shell',
      'pm',
      'clear',
      'eu.qwky.trinity.secondary',
    ]);
    expect(cleanupOptions).toHaveLength(3);
    for (const options of cleanupOptions) {
      expect(options.timeout).toBe(2_000);
      expect(options.signal).not.toBe(controller.signal);
    }
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

  it('treats already-missing forward and reverse listeners as idempotent cleanup', async () => {
    const f = fixture();
    const commands = {
      ...f.commands,
      async run(command, args, options) {
        const operation = args.slice(args[0] === '-s' ? 2 : 0).join(' ');
        if (operation === 'reverse --list') return '';
        if (
          operation === 'forward --remove tcp:4711' ||
          operation === 'reverse --remove tcp:8448'
        ) {
          throw new Error(
            `adb: error: listener '${operation.split(' ').at(-1)}' not found`,
          );
        }
        return f.commands.run(command, args, options);
      },
    };
    const device = await openMaestroDevice(
      {
        ...f.options,
        serial: 'emulator-5554',
        reversePorts: [8448],
      },
      commands,
    );

    await expect(device.removeForward('tcp:4711')).resolves.toBeUndefined();
    await expect(device.close()).resolves.toBeUndefined();
    expect(f.calls).toContainEqual([
      '/sdk/platform-tools/adb',
      '-s',
      'emulator-5554',
      'reverse',
      'tcp:8448',
      'tcp:8448',
    ]);
  });

  it('preserves non-idempotent ADB forward-removal failures', async () => {
    const f = fixture();
    const failure = new Error('adb: error: device offline');
    const device = await openMaestroDevice(
      { ...f.options, serial: 'emulator-5554' },
      {
        ...f.commands,
        async run(command, args, options) {
          const operation = args.slice(args[0] === '-s' ? 2 : 0).join(' ');
          if (operation === 'forward --remove tcp:4711') throw failure;
          return f.commands.run(command, args, options);
        },
      },
    );

    await expect(device.removeForward('tcp:4711')).rejects.toBe(failure);
    await device.close();
  });

  it.each(['selection', 'push'])(
    'removes a staged document before device teardown when %s is cancelled',
    async (cancelDuring) => {
      const f = fixture();
      const controller = new AbortController();
      const cancellation = new Error('invocation cancelled');
      const flowFailure = new Error('selection interrupted');
      const staged = new Set();
      const removalOptions = [];
      const commands = {
        ...f.commands,
        async run(command, args, options) {
          options?.signal?.throwIfAborted();
          const operation = args.slice(2);
          if (operation[0] === 'push') {
            staged.add(operation[2]);
            if (cancelDuring === 'push') {
              controller.abort(cancellation);
              throw cancellation;
            }
          }
          if (operation[0] === 'exec-out') {
            return '<hierarchy><node text="Photos" package="com.google.android.photopicker" bounds="[10,10][30,30]"/><node text="Albums" package="com.google.android.photopicker" bounds="[40,10][60,30]"/><node clickable="true" enabled="true" package="com.google.android.photopicker" bounds="[70,10][90,30]"/></hierarchy>';
          }
          if (operation[0] === 'shell' && operation[1] === 'rm') {
            expect(f.closed()).toBe(0);
            removalOptions.push(options);
            staged.delete(operation[3]);
          }
          return f.commands.run(command, args, options);
        },
      };
      const device = await openMaestroDevice(
        { ...f.options, signal: controller.signal },
        commands,
      );
      const result = await pickAndroidDocument(
        {
          ...device,
          async runFlow() {
            controller.abort(cancellation);
            throw flowFailure;
          },
        },
        f.options.workspaceRoot,
        '/fixture/photo.png',
        'space-photo.png',
      ).catch((error) => error);
      await device.close();

      expect([...staged]).toEqual([]);
      expect(result).toBe(cancelDuring === 'push' ? cancellation : flowFailure);
      expect(removalOptions).toHaveLength(1);
      expect(removalOptions[0].timeout).toBe(2_000);
      expect(removalOptions[0].signal).not.toBe(controller.signal);
      expect(removalOptions[0].signal.aborted).toBe(false);
      expect(f.closed()).toBe(1);
    },
  );

  it('preserves selection and document cleanup failures together', async () => {
    const f = fixture();
    const flowFailure = new Error('selection failed');
    const cleanupFailure = new Error('document removal failed');
    const device = await openMaestroDevice(f.options, {
      ...f.commands,
      async run(command, args, options) {
        if (args.includes('exec-out'))
          return '<hierarchy><node text="Photos" package="com.google.android.photopicker" bounds="[10,10][30,30]"/><node text="Albums" package="com.google.android.photopicker" bounds="[40,10][60,30]"/><node clickable="true" enabled="true" package="com.google.android.photopicker" bounds="[70,10][90,30]"/></hierarchy>';
        if (args.includes('rm')) throw cleanupFailure;
        return f.commands.run(command, args, options);
      },
    });
    const result = await pickAndroidDocument(
      {
        ...device,
        async runFlow() {
          throw flowFailure;
        },
      },
      f.options.workspaceRoot,
      '/fixture/photo.png',
      'space-photo.png',
    ).catch((error) => error);
    await device.close();

    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors).toEqual([flowFailure, cleanupFailure]);
    expect(f.closed()).toBe(1);
  });

  it('redacts secret variables from text artifacts and removes image diagnostics', async () => {
    const f = fixture();
    const output = join(f.options.artifactDirectory, 'redaction');
    const password = 'quoted "secret"\\value';
    const recoveryKey = 'EsTx secret recovery key';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(output, 'commands.json'),
      JSON.stringify({
        defineVariablesCommand: {
          env: { PASSWORD: password, RECOVERY_KEY: recoveryKey },
        },
        evaluatedCommand: {
          env: { PASSWORD: password, RECOVERY_KEY: recoveryKey },
        },
      }),
    );
    writeFileSync(
      join(output, 'maestro.log'),
      `login started: ${password}\nrecovery: ${recoveryKey}\n`,
    );
    writeFileSync(join(output, 'screenshot.png'), png);

    await redactMaestroArtifacts(
      output,
      {
        PASSWORD: password,
        RECOVERY_KEY: recoveryKey,
        HOMESERVER: 'https://example.test',
      },
      true,
    );

    const commands = JSON.parse(
      readFileSync(join(output, 'commands.json'), 'utf8'),
    );
    expect(commands.defineVariablesCommand.env.PASSWORD).toBe('[REDACTED]');
    expect(commands.defineVariablesCommand.env.RECOVERY_KEY).toBe('[REDACTED]');
    expect(commands.evaluatedCommand.env.PASSWORD).toBe('[REDACTED]');
    expect(commands.evaluatedCommand.env.RECOVERY_KEY).toBe('[REDACTED]');
    expect(readFileSync(join(output, 'maestro.log'), 'utf8')).toBe(
      'login started: [REDACTED]\nrecovery: [REDACTED]\n',
    );
    expect(existsSync(join(output, 'screenshot.png'))).toBe(false);
  });

  it('redacts every Matrix Room and event id shape from Maestro text output', async () => {
    const output = mkdtempSync(join(tmpdir(), 'trinity-maestro-identifiers-'));
    try {
      const eventId = `$${'aB3_-'.repeat(8)}xyz`;
      mkdirSync(join(output, 'flow', 'logs'), { recursive: true });
      writeFileSync(
        join(output, 'flow', 'logs', 'device-logcat.txt'),
        `I Capacitor/Console: Event ${eventId} already in timeline\n`,
      );
      writeFileSync(
        join(output, 'flow.yaml'),
        '# !AbCdEfGhIjKlMnOpQr:localhost\n',
      );
      await redactMaestroArtifacts(output, {});
      expect(
        readFileSync(join(output, 'flow', 'logs', 'device-logcat.txt'), 'utf8'),
      ).toBe('I Capacitor/Console: Event [REDACTED] already in timeline\n');
      expect(readFileSync(join(output, 'flow.yaml'), 'utf8')).toBe(
        '# [REDACTED]\n',
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
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
    expect(log).not.toContain(nativePreferenceSecret);
    expect(log).toContain('Msg: [REDACTED]');
    expect(log.match(/methodData: \[REDACTED\]/gu)).toHaveLength(2);
    expect(log).toContain('App resumed');
    await device.close();
  });

  it('uses a distinct driver port for each flow in one device lease', async () => {
    const f = fixture();
    configureMaestro(f);
    const device = await openMaestroDevice(
      { ...f.options, serial: 'emulator-5554' },
      f.commands,
    );

    await device.runFlow('/flows/first.yaml');
    await device.runFlow('/flows/second.yaml');

    const ports = readdirSync(f.options.artifactDirectory)
      .filter((name) => name.startsWith('first-') || name.startsWith('second-'))
      .map((name) => {
        const { cliArgs } = JSON.parse(
          readFileSync(
            join(f.options.artifactDirectory, name, 'commands.json'),
            'utf8',
          ),
        );
        const option = cliArgs.indexOf('--driver-host-port');
        expect(option).toBeGreaterThanOrEqual(0);
        expect(option).toBeLessThan(cliArgs.indexOf('test'));
        return Number(cliArgs[option + 1]);
      });
    expect(ports).toHaveLength(2);
    expect(new Set(ports).size).toBe(2);
    expect(ports.every((port) => Number.isInteger(port) && port > 0)).toBe(
      true,
    );
    expect(ports.every((port) => port < 32768 || port > 60999)).toBe(true);
    expect(
      f.calls.filter((call) => call.includes('/proc/net/tcp6')),
    ).toHaveLength(2);
    await device.close();
  });

  it('does not launch Maestro when Android has no eligible driver port', async () => {
    const f = fixture();
    configureMaestro(f);
    const run = f.commands.run;
    f.commands.run = async (command, args, options) => {
      if (args.includes('/proc/sys/net/ipv4/ip_local_port_range'))
        return '1024 65535\nsl local_address rem_address st\nsl local_address remote_address st\n';
      return run(command, args, options);
    };
    const device = await openMaestroDevice(
      { ...f.options, serial: 'emulator-5554' },
      f.commands,
    );
    try {
      await expect(device.runFlow('/flows/read.yaml')).rejects.toThrow(
        'No available',
      );
      expect(
        existsSync(
          join(f.options.workspaceRoot, 'maestro-driver-port-attempts.json'),
        ),
      ).toBe(false);
    } finally {
      await device.close();
    }
  });

  it('retries a pre-start driver-port rejection with a fresh port', async () => {
    const f = fixture();
    configureMaestro(f, { driverPortFailures: 1 });
    const device = await openMaestroDevice(
      { ...f.options, serial: 'emulator-5554' },
      f.commands,
    );

    await expect(device.runFlow('/flows/read.yaml')).resolves.toBeUndefined();

    const ports = JSON.parse(
      readFileSync(
        join(f.options.workspaceRoot, 'maestro-driver-port-attempts.json'),
        'utf8',
      ),
    );
    expect(ports).toHaveLength(2);
    expect(new Set(ports).size).toBe(2);
    await device.close();
  });

  it('bounds repeated pre-start driver-port retries', async () => {
    const f = fixture();
    configureMaestro(f, { driverPortFailures: 4 });
    const device = await openMaestroDevice(
      { ...f.options, serial: 'emulator-5554' },
      f.commands,
    );

    await expect(device.runFlow('/flows/read.yaml')).rejects.toThrow(
      'Maestro read.yaml failed (1)',
    );

    const ports = JSON.parse(
      readFileSync(
        join(f.options.workspaceRoot, 'maestro-driver-port-attempts.json'),
        'utf8',
      ),
    );
    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
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
