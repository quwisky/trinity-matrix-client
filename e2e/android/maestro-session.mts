import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runManagedCommand } from '../support/managed-command.mts';
import { readSession } from '../support/session.mts';
import {
  acquireProcessLock,
  releaseProcessLock,
  type ProcessLock,
} from '../support/process-lock.mts';
import {
  DEFAULT_AVD,
  chooseEmulatorPort,
  parseDevices,
  parseOnlineDevices,
  reverseTarget,
  validateEmulator,
} from './device.mts';

const executeFile = promisify(execFile);
const applicationId = 'eu.qwky.trinity';
type MaestroApplicationId = 'eu.qwky.trinity' | 'eu.qwky.trinity.secondary';

const textArtifactExtensions = new Set([
  '.json',
  '.jsonl',
  '.log',
  '.txt',
  '.xml',
]);
const redactedSecret = '[REDACTED]';

const secretValues = (
  variables: Readonly<Record<string, string>>,
): readonly string[] =>
  [
    ...new Set(
      Object.entries(variables)
        .filter(([key, value]) => /password|secret|token/iu.test(key) && value)
        .flatMap(([, value]) => {
          const escaped = JSON.stringify(value);
          return escaped ? [value, escaped.slice(1, -1)] : [value];
        }),
    ),
  ].sort((left, right) => right.length - left.length);

const redactText = (text: string, secrets: readonly string[]): string =>
  secrets.reduce(
    (redacted, secret) => redacted.replaceAll(secret, redactedSecret),
    text,
  );

/** Redact supplied secret flow variables from Maestro's text diagnostics. */
export async function redactMaestroArtifacts(
  directory: string,
  variables: Readonly<Record<string, string>>,
): Promise<void> {
  const secrets = secretValues(variables);
  if (!secrets.length) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      await redactMaestroArtifacts(file, variables);
      continue;
    }
    if (!entry.isFile())
      throw new Error(`Cannot redact non-file Maestro artifact: ${entry.name}`);
    if (!textArtifactExtensions.has(file.slice(file.lastIndexOf('.'))))
      continue;
    const text = await readFile(file, 'utf8');
    const redacted = redactText(text, secrets);
    if (redacted !== text) await writeFile(file, redacted, 'utf8');
  }
}

export interface EmulatorProcess {
  assertRunning(): void;
  close(): Promise<void>;
}

export interface AndroidCommandOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

export interface AndroidCommands {
  run(
    command: string,
    args: readonly string[],
    options?: AndroidCommandOptions,
  ): Promise<string>;
  startEmulator(
    command: string,
    args: readonly string[],
    logFile: string,
  ): EmulatorProcess;
}

const systemCommands: AndroidCommands = {
  async run(command, args, options = {}) {
    const { stdout } = await executeFile(command, [...args], {
      signal: options.signal,
      timeout: options.timeout ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  },
  startEmulator(command, args, logFile) {
    const descriptor = openSync(logFile, 'w');
    const child = spawn(command, [...args], {
      // The outer Node invocation supervises this process group, including
      // descendants left behind after cancellation or a killed test worker.
      detached: false,
      stdio: ['ignore', descriptor, descriptor],
    });
    closeSync(descriptor);
    let failure: Error | undefined;
    child.once('error', (error) => {
      failure = error;
    });
    let exited = false;
    const exit = new Promise<void>((resolve) => {
      child.once('exit', () => {
        exited = true;
        resolve();
      });
      child.once('error', () => {
        exited = true;
        resolve();
      });
    });
    return {
      assertRunning() {
        if (failure) throw failure;
        if (exited) throw new Error('Owned Android emulator exited');
      },
      async close() {
        if (exited) return;
        const signal = (value: NodeJS.Signals): void => {
          try {
            child.kill(value);
          } catch (error) {
            if (!exited) throw error;
          }
        };
        signal('SIGTERM');
        await Promise.race([exit, delay(5_000)]);
        if (!exited) {
          signal('SIGKILL');
          await Promise.race([exit, delay(5_000)]);
        }
        if (!exited) throw new Error('Owned Android emulator did not stop');
      },
    };
  },
};

export interface MaestroDeviceOptions {
  readonly workspaceRoot: string;
  readonly artifactDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** Explicitly borrowed disposable emulator. An omitted serial starts a private overlay. */
  readonly serial?: string;
  readonly avd?: string;
  readonly cameraFile?: string;
  readonly reversePorts?: readonly number[];
  readonly bootTimeoutMs?: number;
}

export interface MaestroDevice {
  readonly serial: string;
  readonly artifactDirectory: string;
  adb(...args: string[]): Promise<string>;
  removeForward(local: string): Promise<void>;
  install(apk: string, applicationId?: MaestroApplicationId): Promise<void>;
  launch(): Promise<void>;
  runFlow(
    file: string,
    variables?: Readonly<Record<string, string>>,
  ): Promise<void>;
  close(): Promise<void>;
}

/** One explicit device lease under the invocation's outer Android resource lock. */
export async function openMaestroDevice(
  options: MaestroDeviceOptions,
  commands: AndroidCommands = systemCommands,
): Promise<MaestroDevice> {
  const environment = options.environment ?? process.env;
  const session = readSession(environment['TRINITY_E2E_SESSION_FILE'], {
    requireLiveOwner: true,
  });
  if (!session.resources.includes('android-avd')) {
    throw new Error('Maestro requires the invocation android-avd resource');
  }
  const sdk = environment['ANDROID_HOME'] ?? environment['ANDROID_SDK_ROOT'];
  if (!sdk) throw new Error('Android SDK path is unavailable');
  options.signal?.throwIfAborted();
  const adbBinary = join(sdk, 'platform-tools/adb');
  const emulatorBinary = join(sdk, 'emulator/emulator');
  const avd = options.avd ?? DEFAULT_AVD;
  let serial = options.serial ?? '';
  let processLease: EmulatorProcess | undefined;
  let lock: ProcessLock | undefined;
  const installedApplicationIds = new Set<MaestroApplicationId>();
  const reverses: Array<{ local: string; previous: string | undefined }> = [];
  let closing: Promise<void> | undefined;
  const rawAdb = (...args: string[]): Promise<string> =>
    commands.run(adbBinary, ['-s', serial, ...args], {
      timeout: 2_000,
      signal: AbortSignal.timeout(2_000),
    });
  const adb = (...args: string[]): Promise<string> =>
    commands.run(adbBinary, ['-s', serial, ...args], {
      signal: options.signal,
    });
  await mkdir(options.artifactDirectory, { recursive: true });

  const close = (): Promise<void> =>
    (closing ??= (async () => {
      options.signal?.removeEventListener('abort', abort);
      const failures: unknown[] = [];
      if (serial && lock) {
        for (const [file, args] of [
          ['logcat.txt', ['logcat', '-d', '-t', '2000']],
          ['activity.txt', ['shell', 'dumpsys', 'activity', 'activities']],
        ] as const) {
          const output = await rawAdb(...args).catch(
            (error: unknown) => `Diagnostic unavailable: ${String(error)}`,
          );
          await writeFile(join(options.artifactDirectory, file), output).catch(
            (error: unknown) => failures.push(error),
          );
        }
        for (const installedApplicationId of installedApplicationIds) {
          await rawAdb(
            'shell',
            'am',
            'force-stop',
            installedApplicationId,
          ).catch((error: unknown) => failures.push(error));
        }
        for (const { local, previous } of [...reverses].reverse()) {
          try {
            if (previous) await rawAdb('reverse', local, previous);
            else await rawAdb('reverse', '--remove', local);
          } catch (error) {
            failures.push(error);
          }
        }
      }
      try {
        await processLease?.close();
      } catch (error) {
        failures.push(error);
      }
      releaseProcessLock(lock);
      if (failures.length)
        throw new AggregateError(failures, `Android ${serial} cleanup failed`);
    })());
  const abort = (): void => {
    void close().catch(() => undefined);
  };

  try {
    const connected = await commands.run(adbBinary, ['devices'], {
      signal: options.signal,
    });
    if (!serial) {
      const avds = await commands.run(emulatorBinary, ['-list-avds'], {
        signal: options.signal,
      });
      if (!avds.split(/\r?\n/).includes(avd))
        throw new Error(`Required Android AVD ${avd} is unavailable`);
      const reserved = parseDevices(connected).map((device) => device.serial);
      while (!lock) {
        serial = `emulator-${chooseEmulatorPort(reserved)}`;
        try {
          lock = acquireProcessLock(
            join(options.workspaceRoot, 'dist/e2e-locks', `${serial}.lock`),
            serial,
          );
        } catch {
          reserved.push(serial);
        }
      }
      processLease = commands.startEmulator(
        emulatorBinary,
        [
          '-avd',
          avd,
          '-port',
          serial.slice('emulator-'.length),
          '-read-only',
          '-no-snapshot',
          '-no-window',
          '-no-audio',
          '-no-boot-anim',
          '-gpu',
          'swiftshader',
          '-camera-back',
          options.cameraFile ? `imagefile:${options.cameraFile}` : 'emulated',
        ],
        join(options.artifactDirectory, 'emulator.log'),
      );
    } else {
      if (!/^emulator-\d+$/.test(serial))
        throw new Error('Maestro requires an explicit disposable emulator');
      if (!parseOnlineDevices(connected).includes(serial))
        throw new Error(`${serial} is not online`);
      lock = acquireProcessLock(
        join(options.workspaceRoot, 'dist/e2e-locks', `${serial}.lock`),
        serial,
      );
    }
    const deadline = Date.now() + (options.bootTimeoutMs ?? 180_000);
    let booted = false;
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      processLease?.assertRunning();
      try {
        booted =
          (await adb('shell', 'getprop', 'sys.boot_completed')) === '1' &&
          (await adb('shell', 'pm', 'path', 'android')).startsWith('package:');
      } catch {
        options.signal?.throwIfAborted();
      }
      if (booted) break;
      await delay(250, undefined, { signal: options.signal });
    }
    if (!booted) throw new Error(`Timed out waiting for ${serial} boot`);
    const problems = validateEmulator({
      qemu: await adb('shell', 'getprop', 'ro.kernel.qemu'),
      apiLevel: await adb('shell', 'getprop', 'ro.build.version.sdk'),
      abi: await adb('shell', 'getprop', 'ro.product.cpu.abi'),
    });
    if (problems.length) throw new Error(`${serial}: ${problems.join('; ')}`);
    const existing = await adb('reverse', '--list');
    for (const port of options.reversePorts ?? [8448, 5556]) {
      const local = `tcp:${port}`;
      const previous = reverseTarget(existing, local);
      if (previous === local) continue;
      reverses.push({ local, previous });
      await adb('reverse', local, local);
    }
    options.signal?.throwIfAborted();
    options.signal?.addEventListener('abort', abort, { once: true });
    return {
      serial,
      artifactDirectory: options.artifactDirectory,
      adb,
      close,
      async removeForward(local) {
        await rawAdb('forward', '--remove', local);
      },
      async install(apk, installedApplicationId = applicationId) {
        installedApplicationIds.add(installedApplicationId);
        await adb('install', '-r', '-t', apk);
      },
      async launch() {
        await adb(
          'shell',
          'am',
          'start',
          '-n',
          `${applicationId}/eu.qwky.trinity.MainActivity`,
        );
      },
      async runFlow(file, variables = {}) {
        const output = join(
          options.artifactDirectory,
          `${basename(file, '.yaml')}-${randomUUID()}`,
        );
        const privateOutput = join(
          options.workspaceRoot,
          'dist/maestro-private',
          randomUUID(),
        );
        await mkdir(privateOutput, { recursive: true, mode: 0o700 });
        const descriptor = openSync(join(privateOutput, 'maestro.log'), 'w');
        let commandStatus: number | string | undefined;
        let descriptorFailure: unknown;
        try {
          try {
            const result = await runManagedCommand(
              environment['MAESTRO_CLI'] ?? 'maestro',
              [
                '--device',
                serial,
                'test',
                '--test-output-dir',
                privateOutput,
                '--format',
                'JUNIT',
                '--output',
                join(privateOutput, 'junit.xml'),
                ...Object.entries(variables).flatMap(([key, value]) => [
                  '-e',
                  `${key}=${value}`,
                ]),
                file,
              ],
              {
                cwd: options.workspaceRoot,
                environment,
                signal: options.signal,
                timeout: 300_000,
                stdio: ['ignore', descriptor, descriptor],
              },
            );
            if (result.status !== 0) commandStatus = result.status ?? 'unknown';
          } catch {
            commandStatus = 'unknown';
          }
        } finally {
          try {
            closeSync(descriptor);
          } catch (error) {
            descriptorFailure = error;
          }
        }
        let redactionFailure = false;
        try {
          await redactMaestroArtifacts(privateOutput, variables);
        } catch {
          redactionFailure = true;
        }
        const commandFailure =
          commandStatus !== undefined || descriptorFailure
            ? new Error(
                `Maestro ${basename(file)} failed (${commandStatus ?? 'output cleanup'}); diagnostics remain private`,
              )
            : undefined;
        if (redactionFailure) {
          const scrubFailure = new Error(
            'Maestro diagnostics redaction failed',
          );
          if (commandFailure)
            throw new AggregateError(
              [commandFailure, scrubFailure],
              `Maestro ${basename(file)} failed and diagnostics redaction failed`,
            );
          throw scrubFailure;
        }
        await mkdir(options.artifactDirectory, { recursive: true });
        try {
          await rename(privateOutput, output);
        } catch {
          throw new Error(
            `Maestro ${basename(file)} diagnostics could not be published`,
          );
        }
        if (commandFailure)
          throw new Error(
            `Maestro ${basename(file)} failed (${commandStatus ?? 'output cleanup'}); diagnostics: ${output}`,
          );
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Android startup and cleanup failed',
      );
    }
    throw error;
  }
}
