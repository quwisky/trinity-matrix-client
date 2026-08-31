import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  registrySnapshot,
  validateRegistry,
  validateWorkspace,
  yamlRunCommands,
} from './e2e-suite-registry-validator.mjs';
import {
  checkPrerequisites,
  main,
  runManagedCommand,
  runSelection,
  runSuite,
  selectSuites,
  suitesForRun,
} from './e2e-suite-registry.mjs';

const workspaceRoot = join(import.meta.dirname, '..');

describe('E2E suite registry', () => {
  it('matches the current workspace entrypoints, targets, commands and CI', () => {
    expect(validateWorkspace(workspaceRoot)).toEqual([]);
  });

  it('rejects duplicate target ownership and serialization resources', () => {
    const snapshot = registrySnapshot();
    snapshot.suites[1].currentTarget = snapshot.suites[0].currentTarget;
    snapshot.resources.push(structuredClone(snapshot.resources[0]));

    expect(validateRegistry(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicate current target'),
        expect.stringContaining('duplicate serialization resource'),
      ]),
    );
  });

  it('rejects cacheable suites and missing annotations or prerequisites', () => {
    const snapshot = registrySnapshot();
    snapshot.suites[0].cachePolicy = 'allowed';
    snapshot.suites[0].capabilities = [];
    snapshot.suites[0].prerequisites = [];

    expect(validateRegistry(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing capability or contract annotations'),
        expect.stringContaining('no explicit prerequisite classification'),
        expect.stringContaining('permits caching'),
      ]),
    );
  });

  it('rejects undefined serialization ownership and command drift', () => {
    const snapshot = registrySnapshot();
    snapshot.suites[0].serializationKeys = ['unowned-stack'];
    snapshot.packageScripts.find(({ name }) => name === 'e2e').command =
      'nx run trinity-e2e:drifted';
    snapshot.packageScripts.find(({ name }) => name === 'e2e:verify').command =
      'nx run trinity-e2e:drifted-compatibility-alias';

    expect(validateWorkspace(workspaceRoot, snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('undefined serialization resource'),
        expect.stringContaining('package script e2e drifted'),
        expect.stringContaining('package script e2e:verify drifted'),
        expect.stringContaining('targets missing Nx task'),
      ]),
    );
  });

  it('requires shared entrypoints to declare their exclusive resource', () => {
    const snapshot = registrySnapshot();
    snapshot.suites.find(
      ({ id }) => id === 'protocol.crypto-spike-webkit',
    ).serializationKeys = [];

    expect(validateWorkspace(workspaceRoot, snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'protocol.crypto-spike-webkit does not serialize shared entrypoint e2e/features/crypto-spike.mjs with crypto-spike-http',
        ),
      ]),
    );
  });

  it('rejects expired or incomplete quarantine entries', () => {
    const snapshot = registrySnapshot();
    snapshot.quarantine.push({
      suiteId: 'browser.canonical',
      issue: '',
      owner: '',
      reason: '',
      expiresOn: '2025-01-01',
      excludedTier: 'pull-request',
    });

    expect(
      validateRegistry(snapshot, new Date('2026-08-30T00:00:00Z')),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing issue, owner or reason'),
        expect.stringContaining('expired on 2025-01-01'),
      ]),
    );
  });

  it('rejects unregistered targets, entrypoints and CI commands', () => {
    const snapshot = registrySnapshot();
    snapshot.inventory.trackedTargetProjects[0].ignoredTargets = ['typecheck'];
    snapshot.suites[0].sourceEntrypoints = [];
    snapshot.ciEntrypoints = snapshot.ciEntrypoints.filter(
      ({ suiteIds }) => !suiteIds.includes('browser.canonical'),
    );

    expect(validateWorkspace(workspaceRoot, snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unregistered E2E target: trinity-e2e:lint'),
        expect.stringContaining('has no source entrypoint'),
        expect.stringContaining('unregistered E2E entrypoint'),
        expect.stringContaining('unregistered CI E2E entrypoint'),
      ]),
    );
  });

  it('rejects canonical spec-count and aggregate-target drift', () => {
    const snapshot = registrySnapshot();
    snapshot.inventory.canonicalBrowserSpecCount = 103;
    snapshot.aggregateTargets[0].target = 'missing-target';

    expect(validateWorkspace(workspaceRoot, snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('canonical browser inventory drifted'),
        expect.stringContaining(
          'aggregate target trinity-e2e:missing-target does not exist',
        ),
      ]),
    );
  });

  it('rejects canonical runner bypasses and incomplete CI tiers', () => {
    const snapshot = registrySnapshot();
    snapshot.packageScripts.find(({ name }) => name === 'e2e:web').command =
      'nx run trinity-e2e:web-e2e';
    snapshot.ciEntrypoints = snapshot.ciEntrypoints.filter(
      ({ suiteIds }) => !suiteIds.includes('browser.canonical'),
    );

    expect(validateRegistry(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('e2e:web bypasses the E2E aggregate runner'),
      ]),
    );
    expect(validateWorkspace(workspaceRoot, snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'pull-request suite has no CI entrypoint: browser.canonical',
        ),
      ]),
    );
  });

  it('classifies inline and multiline workflow commands', () => {
    expect(
      yamlRunCommands(`
steps:
  - run: pnpm exec nx run trinity-e2e:storybook-e2e
  - run: |
      pnpm build
      pnpm e2e:web
`),
    ).toEqual(['pnpm exec nx run trinity-e2e:storybook-e2e', 'pnpm e2e:web']);
  });
});

describe('E2E suite registry runner', () => {
  it('selects environment suites and rejects unknown aggregates', () => {
    expect(selectSuites('e2e-web').map(({ id }) => id)).toEqual([
      'web.production-pwa',
    ]);
    expect(() => selectSuites('missing')).toThrow(
      'Unknown E2E aggregate target: missing',
    );
  });

  it('applies quarantine only to its matching CI tier', () => {
    const quarantine = [
      {
        suiteId: 'browser.canonical',
        excludedTier: 'pull-request',
      },
    ];

    expect(
      suitesForRun('e2e-pr', { quarantine }).some(
        ({ id }) => id === 'browser.canonical',
      ),
    ).toBe(false);
    expect(
      suitesForRun('e2e-all', { quarantine }).some(
        ({ id }) => id === 'browser.canonical',
      ),
    ).toBe(true);
  });

  it('reports unavailable external prerequisites without starting suites', async () => {
    const failures = await checkPrerequisites([{ prerequisites: ['docker'] }], {
      execute: () => ({ status: 1 }),
    });

    expect(failures).toEqual(['Docker daemon is unavailable']);
  });

  it('accepts only the canonical local AVD unless a serial is explicit', async () => {
    const androidSuite = [{ prerequisites: ['android-avd'] }];
    const executeWith = (
      devices,
      avdName,
      availableAvds = '',
      properties = {
        'ro.kernel.qemu': '1',
        'ro.build.version.sdk': '36',
        'ro.product.cpu.abi': 'x86_64',
      },
    ) =>
      vi.fn((command, args) => {
        const isAdb = command === 'adb' || command.endsWith('/adb');
        const isEmulator =
          command === 'emulator' || command.endsWith('/emulator');
        if (isAdb && args[0] === 'devices') {
          return { status: 0, stdout: `List of devices attached\n${devices}` };
        }
        if (isAdb && args.includes('avd')) {
          return { status: 0, stdout: `${avdName}\nOK\n` };
        }
        if (isAdb && args.includes('getprop')) {
          return { status: 0, stdout: `${properties[args.at(-1)] ?? ''}\n` };
        }
        if (isEmulator) {
          return { status: 0, stdout: availableAvds };
        }
        return { status: 1, stdout: '' };
      });

    expect(
      await checkPrerequisites(androidSuite, {
        execute: executeWith('emulator-5554\tdevice\n', 'Other_AVD'),
        environment: {},
      }),
    ).toEqual([
      'no validated API 36 x86_64 emulator or startable Trinity_API_36 AVD is available',
    ]);
    expect(
      await checkPrerequisites(androidSuite, {
        execute: executeWith('emulator-5554\tdevice\n', 'Trinity_API_36'),
        environment: {},
      }),
    ).toEqual([]);
    expect(
      await checkPrerequisites(androidSuite, {
        execute: executeWith('device-123\tdevice\n', ''),
        environment: { TRINITY_ANDROID_SERIAL: 'device-123' },
      }),
    ).toEqual([]);
    expect(
      await checkPrerequisites(androidSuite, {
        execute: executeWith('device-123\tdevice\n', '', '', {
          'ro.kernel.qemu': '1',
          'ro.build.version.sdk': '35',
          'ro.product.cpu.abi': 'x86_64',
        }),
        environment: { TRINITY_ANDROID_SERIAL: 'device-123' },
      }),
    ).toEqual([
      'Android device device-123 is not an online API 36 x86_64 emulator',
    ]);
  });

  it('resolves Android tools from the declared SDK root', async () => {
    const calls = [];
    const execute = vi.fn((command, args) => {
      calls.push([command, args]);
      if (command.endsWith('/adb') && args[0] === 'devices') {
        return { status: 0, stdout: 'List of devices attached\n' };
      }
      if (command.endsWith('/emulator')) {
        return { status: 0, stdout: 'Trinity_API_36\n' };
      }
      return { status: 1, stdout: '' };
    });

    expect(
      await checkPrerequisites(
        [{ prerequisites: ['android-sdk', 'android-avd'] }],
        {
          execute,
          environment: { ANDROID_HOME: '/opt/android-sdk' },
          fileExists: (path) =>
            [
              '/opt/android-sdk/platform-tools/adb',
              '/opt/android-sdk/emulator/emulator',
            ].includes(String(path)),
        },
      ),
    ).toEqual([]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ['/opt/android-sdk/platform-tools/adb', ['devices']],
        ['/opt/android-sdk/emulator/emulator', ['-list-avds']],
      ]),
    );
  });

  it('reports missing host, browser and network prerequisites', async () => {
    const failures = await checkPrerequisites(
      [
        {
          prerequisites: [
            'android-sdk',
            'electron',
            'java-21',
            'kvm',
            'xvfb',
            'playwright-chromium',
            'playwright-firefox',
            'playwright-webkit',
            'network',
          ],
        },
      ],
      {
        execute: () => ({ status: 1, stdout: '' }),
        environment: {},
        platform: 'linux',
        fileExists: () => false,
        fileAccessible: () => false,
        playwrightExists: async () => false,
        fetchDiscovery: async () => ({ ok: false }),
      },
    );

    expect(failures).toEqual([
      'ANDROID_HOME or ANDROID_SDK_ROOT must contain platform-tools/adb and emulator/emulator',
      'JDK 21 is unavailable',
      '/dev/kvm is not read/write accessible',
      'Electron dependencies are not installed',
      'xvfb-run is unavailable on headless Linux',
      'chromium is not installed for this Playwright version',
      'firefox is not installed for this Playwright version',
      'webkit is not installed for this Playwright version',
      'matrix.org discovery is unavailable',
    ]);
  });

  it('reports an unreachable network discovery endpoint', async () => {
    const failures = await checkPrerequisites(
      [{ prerequisites: ['network'] }],
      {
        fetchDiscovery: async () => {
          throw new Error('offline');
        },
      },
    );

    expect(failures).toEqual(['public network discovery is unavailable']);
  });

  it('wraps a headless Electron suite with Xvfb', async () => {
    const calls = [];
    const status = await runSuite(
      {
        id: 'electron.smoke',
        currentTarget: 'trinity-desktop:e2e-smoke',
        prerequisites: ['xvfb'],
        timeoutClass: 'host',
      },
      {
        execute: (command, args, options) => {
          calls.push([command, args, options]);
          return { status: 0 };
        },
        environment: {},
        platform: 'linux',
        report: () => undefined,
        forwardedArgs: ['--fail-on-flaky-tests', '--shard=1/4'],
      },
    );

    expect(status).toBe(0);
    expect(calls).toEqual([
      [
        'xvfb-run',
        [
          '-a',
          'pnpm',
          'exec',
          'nx',
          'run',
          'trinity-desktop:e2e-smoke',
          '--',
          '--fail-on-flaky-tests',
          '--shard=1/4',
        ],
        { timeout: 3_600_000 },
      ],
    ]);
  });

  it('escalates a timed-out managed process group', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-e2e-timeout-'));
    const pidFile = join(directory, 'descendant.pid');
    try {
      const startedAt = Date.now();
      const result = await runManagedCommand(
        process.execPath,
        [
          '-e',
          `const { spawn } = require('node:child_process');
           const { writeFileSync } = require('node:fs');
           const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);"], { stdio: 'ignore' });
           writeFileSync(process.argv[1], String(child.pid));
           setInterval(() => undefined, 1000);`,
          pidFile,
        ],
        { timeout: 200, terminationGraceMs: 50, stdio: 'ignore' },
      );

      expect(result).toMatchObject({
        status: 1,
        signal: 'SIGKILL',
        timedOut: true,
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      const descendantPid = Number(readFileSync(pidFile, 'utf8'));
      await vi.waitFor(
        () => expect(() => process.kill(descendantPid, 0)).toThrow(),
        { timeout: 1_000 },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses drift before preflight or execution', async () => {
    const preflight = vi.fn();
    const executeSuite = vi.fn();

    expect(
      await runSelection('e2e-components', {
        validate: () => ['drift'],
        preflight,
        executeSuite,
        reportError: () => undefined,
      }),
    ).toBe(1);
    expect(preflight).not.toHaveBeenCalled();
    expect(executeSuite).not.toHaveBeenCalled();
  });

  it('preflights the whole selection before starting its first suite', async () => {
    const executeSuite = vi.fn();

    expect(
      await runSelection('e2e-components', {
        validate: () => [],
        preflight: async () => ['missing browser'],
        executeSuite,
        reportError: () => undefined,
      }),
    ).toBe(1);
    expect(executeSuite).not.toHaveBeenCalled();
  });

  it('runs sequentially and stops at the first failing suite', async () => {
    const executed = [];
    const statuses = [0, 7, 0];

    expect(
      await runSelection('e2e-components', {
        validate: () => [],
        preflight: async () => [],
        executeSuite: ({ id }) => {
          executed.push(id);
          return statuses.shift();
        },
        reportError: () => undefined,
      }),
    ).toBe(7);
    expect(executed).toEqual(['components.storybook', 'components.styling']);
  });

  it('forwards CLI arguments through the aggregate runner', async () => {
    const executeSelection = vi.fn(async () => 0);

    expect(
      await main(
        ['run', 'e2e-android', '--', '--fail-on-flaky-tests', '--shard=2/4'],
        { executeSelection },
      ),
    ).toBe(0);
    expect(executeSelection).toHaveBeenCalledWith('e2e-android', {
      forwardedArgs: ['--fail-on-flaky-tests', '--shard=2/4'],
    });
  });
});
