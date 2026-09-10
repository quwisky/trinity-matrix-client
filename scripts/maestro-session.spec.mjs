import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openMaestroDevice } from '../e2e/android/maestro-session.mts';
import { writeSession } from '../e2e/support/session.mts';

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
        TRINITY_E2E_SESSION_FILE: sessionFile,
      },
    },
  };
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
