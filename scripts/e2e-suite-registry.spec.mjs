import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_ASSERTION_BASELINE,
  captureBrowserAssertionInventory,
} from './e2e-browser-inventory.mjs';
import CapabilityCoverageReporter, {
  browserJourneyPath,
} from '../e2e/browser/capability-coverage.reporter.mts';
import {
  registrySnapshot,
  validateDurableE2ENames,
  validateRegistry,
  validateCiReportPaths,
  validateWorkspace,
  yamlReportPaths,
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
import {
  E2E_SAFE_COMPLETION_FILE,
  E2E_SAFE_COMPLETION_SUITE,
} from '../e2e/support/run-playwright.mts';

const workspaceRoot = join(import.meta.dirname, '..');
const discardReport = () => undefined;

const runnerSuite = (overrides = {}) => ({
  id: 'components.storybook',
  environment: 'components',
  capabilities: ['design-system'],
  contractTypes: ['visual'],
  currentTarget: 'trinity-e2e-components:storybook',
  targetProject: 'trinity-e2e-components',
  prerequisites: ['playwright-chromium'],
  availabilityPolicy: 'required',
  ciTier: 'pull-request',
  serializationKeys: [],
  timeoutClass: 'medium',
  ...overrides,
});

const scheduledInvocation = (environment = {}) => {
  const artifactsRoot = mkdtempSync(join(tmpdir(), 'trinity-e2e-scheduled-'));
  return {
    descriptor: { id: 'run-12345678', artifactsRoot },
    environment,
    close: async () => rmSync(artifactsRoot, { recursive: true, force: true }),
  };
};

const writeCompletion = (environment, suiteId, status) => {
  mkdirSync(join(environment[E2E_SAFE_COMPLETION_FILE], '..'), {
    recursive: true,
  });
  writeFileSync(
    environment[E2E_SAFE_COMPLETION_FILE],
    `${JSON.stringify({ schemaVersion: 1, suiteId, status })}\n`,
  );
};

describe('E2E suite registry', () => {
  // Resolves every owned Nx project on a cold hosted runner. The first public
  // run exceeded 30 seconds; this is a graph contract, not a performance budget.
  it('matches the current workspace entrypoints, targets, commands and CI', () => {
    expect(validateWorkspace(workspaceRoot)).toEqual([]);
  }, 120_000);

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
    snapshot.suites[0].availabilityPolicy = undefined;

    expect(validateRegistry(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing capability or contract annotations'),
        expect.stringContaining('no explicit prerequisite classification'),
        expect.stringContaining('no explicit availability policy'),
        expect.stringContaining('permits caching'),
      ]),
    );
  });

  it('locks canonical browser and Android suites to one CI retry', () => {
    const snapshot = registrySnapshot();
    snapshot.suites.find(({ id }) => id === 'browser.canonical').ciRetries = 2;

    expect(validateWorkspace(workspaceRoot, snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'browser.canonical must allow exactly one CI retry',
        ),
      ]),
    );
    expect(
      snapshot.suites.find(({ id }) => id === 'android.installed-webview')
        .ciRetries,
    ).toBe(1);
  });

  it('rejects missing or mismatched CI preparation metadata', () => {
    const snapshot = registrySnapshot();
    snapshot.suites.find(
      ({ id }) => id === 'components.storybook',
    ).ciPreparation = {
      buildTarget: 'trinity:build:development',
    };
    expect(validateRegistry(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'components.storybook has incorrect CI preparation metadata',
        ),
      ]),
    );

    const container = snapshot.suites.find(({ id }) => id === 'web.container');
    container.ciPreparation = { buildTarget: 'trinity:build:development' };
    expect(validateRegistry(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'web.container must not declare CI preparation metadata',
        ),
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

  it('requires both compatibility aliases to serialize the shared crypto driver', () => {
    const snapshot = registrySnapshot();
    snapshot.suites.find(
      ({ id }) => id === 'protocol.crypto-spike-webkit',
    ).serializationKeys = [];

    expect(validateWorkspace(workspaceRoot, snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'protocol.crypto-spike-webkit does not serialize shared entrypoint e2e/protocol/crypto-spike.spec.mjs with crypto-spike',
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

  it('locks every compatibility alias to the full release-cycle removal gate', () => {
    const snapshot = registrySnapshot();
    snapshot.packageScripts.find(
      ({ kind }) => kind === 'compatibility',
    ).removalAfterRelease = 'next release';

    expect(validateRegistry(snapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('incomplete compatibility removal criteria'),
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
    snapshot.inventory.canonicalBrowserSpecCount = 102;
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

  it('preserves every canonical browser test and assertion source', () => {
    expect(captureBrowserAssertionInventory(workspaceRoot)).toEqual({
      specFiles: BROWSER_ASSERTION_BASELINE.currentSpecFiles,
      testDefinitions: BROWSER_ASSERTION_BASELINE.testDefinitions,
      assertionCalls: BROWSER_ASSERTION_BASELINE.assertionCalls,
      testFingerprint: BROWSER_ASSERTION_BASELINE.testFingerprint,
      assertionFingerprint: BROWSER_ASSERTION_BASELINE.assertionFingerprint,
    });
  });

  it('reports executable browser coverage from the typed journey catalog', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-e2e-coverage-'));
    try {
      const outputFile = join(directory, 'coverage.json');
      const reporter = new CapabilityCoverageReporter({ outputFile });
      const testCase = {
        id: 'one',
        location: {
          file: join(
            workspaceRoot,
            'e2e/browser/journeys/accounts/registration.spec.mts',
          ),
        },
        annotations: [],
        titlePath: () => ['chromium', 'Accounts', 'registers'],
        parent: { project: () => ({ name: 'chromium' }) },
      };
      const result = {
        annotations: [],
        status: 'passed',
        retry: 0,
        duration: 42,
      };

      reporter.onBegin({}, { allTests: () => [testCase] });
      reporter.onTestEnd(testCase, result);
      await reporter.onEnd({ status: 'passed' });

      expect(browserJourneyPath(testCase.location.file)).toBe(
        'journeys/accounts/registration.spec.mts',
      );
      expect(testCase.annotations).toEqual(
        expect.arrayContaining([
          {
            type: 'trinity.e2e.capability',
            description: 'accounts',
          },
          {
            type: 'trinity.e2e.contractType',
            description: 'journey',
          },
        ]),
      );
      const report = JSON.parse(readFileSync(outputFile, 'utf8'));
      expect(report).toMatchObject({
        expectedSpecCount: 122,
        collectedSpecCount: 1,
        testCount: 1,
        attempts: 1,
        retries: 0,
        durationMs: 42,
        byCapability: {
          accounts: {
            specCount: 1,
            testCount: 1,
            statuses: { passed: 1 },
          },
        },
        byContractType: {
          journey: {
            specCount: 1,
            testCount: 1,
            statuses: { passed: 1 },
          },
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires migrated lifecycle targets and artifacts to use their durable owner', () => {
    const artifactSnapshot = registrySnapshot();
    const artifactWeb = artifactSnapshot.suites.find(
      ({ id }) => id === 'web.production-pwa',
    );
    artifactWeb.currentArtifactRoot = 'dist/.playwright/web';

    expect(validateRegistry(artifactSnapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'web.production-pwa current artifacts must use dist/.playwright/trinity-e2e-web/<run-id>',
        ),
      ]),
    );

    const targetSnapshot = registrySnapshot();
    const targetWeb = targetSnapshot.suites.find(
      ({ id }) => id === 'web.production-pwa',
    );
    targetWeb.currentTarget = 'trinity-e2e:web-e2e';

    expect(validateRegistry(targetSnapshot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'web.production-pwa bypasses its active lifecycle project',
        ),
      ]),
    );
  });

  it('rejects historical E2E paths and source names but permits the retained alias', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-e2e-names-'));
    try {
      const phaseName = ['phase', '6'].join('');
      const shippedName = ['shipped', 'UI'].join(' ');
      mkdirSync(join(directory, 'e2e/nested'), { recursive: true });
      writeFileSync(
        join(directory, `e2e/${phaseName}.config.mts`),
        'export {};\n',
      );
      writeFileSync(
        join(directory, 'e2e/nested/active.mts'),
        `export const name = '${shippedName}';\n`,
      );
      writeFileSync(
        join(directory, 'e2e/compat.mts'),
        "export const alias = 'e2e:ui:shipped';\n",
      );
      const errors = [];

      validateDurableE2ENames(errors, directory);

      expect(errors).toEqual(
        expect.arrayContaining([
          `historical E2E name remains in path: e2e/${phaseName}.config.mts`,
          'historical E2E name remains in source: e2e/nested/active.mts',
        ]),
      );
      expect(errors).not.toContain(
        'historical E2E name remains in source: e2e/compat.mts',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it('unwraps the owned CI timeout wrapper before comparing commands', () => {
    expect(
      yamlRunCommands(`
steps:
  - run: node scripts/ci-run-command.mjs --timeout-ms 3600000 -- pnpm exec nx run trinity-e2e-browser:e2e
  - run: TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" node scripts/ci-run-command.mjs --timeout-ms 3600000 -- pnpm e2e:android -- --fail-on-flaky-tests
`),
    ).toEqual([
      'pnpm exec nx run trinity-e2e-browser:e2e',
      'TRINITY_ANDROID_SERIAL="$ANDROID_SERIAL" pnpm e2e:android -- --fail-on-flaky-tests',
    ]);
  });

  it('classifies registry-owned CI report paths', () => {
    expect(
      yamlReportPaths(`
steps:
  - report-path: dist/.playwright/trinity-e2e-browser/*/browser.canonical/**
  - report-path: dist/.playwright/**/**
`),
    ).toEqual([
      'dist/.playwright/trinity-e2e-browser/*/browser.canonical/**',
      'dist/.playwright/**/**',
    ]);

    const snapshot = registrySnapshot();
    const errors = [];
    validateCiReportPaths(
      errors,
      'report-path: dist/.playwright/trinity-e2e-web/*/browser.canonical/**',
      snapshot,
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        'CI report path for browser.canonical targets trinity-e2e-web, expected trinity-e2e-browser',
      ]),
    );
  });
});

describe('E2E suite registry runner', () => {
  it('selects environment suites and rejects unknown aggregates', () => {
    expect(selectSuites('e2e-web').map(({ id }) => id)).toEqual([
      'web.production-pwa',
      'web.production-renderer',
      'web.container',
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
        currentTarget: 'trinity-e2e-electron:smoke',
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
          'trinity-e2e-electron:smoke',
          '--',
          '--fail-on-flaky-tests',
          '--shard=1/4',
        ],
        {
          timeout: 3_600_000,
          cwd: workspaceRoot,
          environment: {},
          signal: undefined,
        },
      ],
    ]);
  });

  it.each([
    { name: 'timeout', result: { status: 1, timedOut: true } },
    { name: 'signal', result: { status: 1, signal: 'SIGKILL' } },
    {
      name: 'process error',
      result: { status: 1, error: new Error('spawn failed') },
    },
  ])(
    'rejects an unsafe managed $name outcome for scheduled execution',
    async ({ result }) => {
      await expect(
        runSuite(
          {
            id: 'components.storybook',
            currentTarget: 'trinity-e2e-components:storybook',
            prerequisites: [],
            timeoutClass: 'medium',
          },
          {
            execute: () => result,
            report: () => undefined,
            rejectUnsafeOutcome: true,
          },
        ),
      ).rejects.toThrow('managed suite process ended unsafely');
    },
  );

  it('reports a managed command timeout', async () => {
    const result = await runManagedCommand(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1000);'],
      { timeout: 200, terminationGraceMs: 50, stdio: 'ignore' },
    );

    expect(result).toMatchObject({ status: 1, timedOut: true });
  });

  it('escalates cancellation of a ready managed process group', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-e2e-escalation-'));
    const pidFile = join(directory, 'descendant.pid');
    const controller = new AbortController();
    const completion = runManagedCommand(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process');
         spawn(process.execPath, ['-e', "process.on('SIGTERM', () => undefined); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => undefined, 1000);", process.argv[1]], { stdio: 'ignore' });
         setInterval(() => undefined, 1000);`,
        pidFile,
      ],
      { signal: controller.signal, terminationGraceMs: 50, stdio: 'ignore' },
    );

    try {
      // The descendant publishes its PID only after installing the SIGTERM handler.
      // Startup speed must not determine whether the process group needs escalation.
      await vi.waitFor(
        () => expect(Number(readFileSync(pidFile, 'utf8'))).toBeGreaterThan(0),
        { timeout: 10_000 },
      );
      const descendantPid = Number(readFileSync(pidFile, 'utf8'));
      controller.abort();

      expect(await completion).toMatchObject({
        status: 1,
        signal: 'SIGKILL',
        timedOut: false,
      });
      await vi.waitFor(
        () => expect(() => process.kill(descendantPid, 0)).toThrow(),
        { timeout: 1_000 },
      );
    } finally {
      controller.abort();
      await completion;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('refuses drift before preflight or execution', async () => {
    const preflight = vi.fn();
    const executeSuite = vi.fn();

    expect(
      await runSelection('e2e-components', {
        validate: () => ['drift'],
        preflight,
        executeSuite,
        reportError: () => undefined,
        writeReport: discardReport,
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
        writeReport: discardReport,
        reportOutput: () => undefined,
      }),
    ).toBe(1);
    expect(executeSuite).not.toHaveBeenCalled();
  });

  it('rejects any remote protocol aggregate before preflight or invocation', async () => {
    const preflight = vi.fn();
    const openInvocation = vi.fn();
    const reportError = vi.fn();

    for (const target of ['e2e-protocol', 'e2e-pr']) {
      expect(
        await runSelection(target, {
          environment: { TRINITY_E2E_PROTOCOL_MODE: 'remote' },
          validate: () => [],
          preflight,
          openInvocation,
          reportError,
          writeReport: discardReport,
        }),
      ).toBe(1);
    }
    expect(preflight).not.toHaveBeenCalled();
    expect(openInvocation).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining('focused-only'),
    );
  });

  it('runs sequentially and stops at the first failing suite', async () => {
    const executed = [];
    const statuses = [0, 7, 0];
    const close = vi.fn(async () => undefined);

    expect(
      await runSelection('e2e-components', {
        validate: () => [],
        preflight: async () => [],
        executeSuite: ({ id }) => {
          executed.push(id);
          return statuses.shift();
        },
        openInvocation: async (resources) => ({
          environment: { TRINITY_TEST_RESOURCES: resources.join(',') },
          close,
        }),
        reportError: () => undefined,
        writeReport: discardReport,
        reportOutput: () => undefined,
      }),
    ).toBe(7);
    expect(executed).toEqual(['components.storybook', 'components.styling']);
    expect(close).toHaveBeenCalledOnce();
  });

  it('continues scheduled suites after a completed failure and retains failure', async () => {
    const suites = [
      runnerSuite(),
      runnerSuite({
        id: 'components.styling',
        currentTarget: 'trinity-e2e-components:styling',
      }),
      runnerSuite({
        id: 'components.accessibility',
        currentTarget: 'trinity-e2e-components:accessibility',
      }),
    ];
    const executed = [];
    const writeReport = vi.fn(() => undefined);
    const statuses = [7, 0, 0];

    expect(
      await runSelection('e2e-scheduled', {
        validate: () => [],
        select: () => suites,
        preflight: async () => [],
        executeSuite: ({ id }, { environment }) => {
          executed.push(id);
          const status = statuses.shift();
          writeCompletion(environment, id, status);
          return status;
        },
        openInvocation: async (resources) => ({
          ...scheduledInvocation(),
          environment: { TRINITY_TEST_RESOURCES: resources.join(',') },
          close: async () => undefined,
        }),
        readSuiteResult: ({ suiteId } = {}) => ({
          schemaVersion: 1,
          suiteId: suiteId ?? suites[executed.length - 1]?.id,
          status: 'passed',
          attempts: 1,
          retries: 0,
          durationMs: 5,
          attemptDurationMs: 5,
          attemptsByStatus: { passed: 1 },
        }),
        writeReport,
        reportError: () => undefined,
        reportOutput: () => undefined,
      }),
    ).toBe(7);
    expect(executed).toEqual(suites.map(({ id }) => id));
    expect(writeReport.mock.calls[0][1].suites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: suites[0].id, outcome: 'failure' }),
        expect.objectContaining({ id: suites[1].id, outcome: 'pass' }),
        expect.objectContaining({ id: suites[2].id, outcome: 'pass' }),
      ]),
    );
  });

  it('stops scheduled suites after an unsafe nested managed outcome', async () => {
    const suites = [
      runnerSuite(),
      runnerSuite({
        id: 'components.styling',
        currentTarget: 'trinity-e2e-components:styling',
      }),
    ];
    const writeReport = vi.fn(() => undefined);
    const executeSuite = vi.fn((suite, executionOptions) =>
      runSuite(suite, {
        ...executionOptions,
        execute: async () => ({ status: 1, signal: 'SIGTERM' }),
      }),
    );

    expect(
      await runSelection('e2e-scheduled', {
        validate: () => [],
        select: () => suites,
        preflight: async () => [],
        executeSuite,
        openInvocation: async () => ({
          ...scheduledInvocation(),
          environment: {},
          close: async () => undefined,
        }),
        writeReport,
        reportError: () => undefined,
        reportOutput: () => undefined,
      }),
    ).toBe(1);
    expect(executeSuite).toHaveBeenCalledOnce();
    expect(writeReport.mock.calls[0][1].suites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: suites[0].id, outcome: 'failure' }),
        expect.objectContaining({ id: suites[1].id, outcome: 'not-run' }),
      ]),
    );
  });

  it.each([
    {
      name: 'a missing record',
      write: () => undefined,
      detail: 'scheduled suite emitted no safe completion record',
    },
    {
      name: 'a malformed record',
      write: (file) => writeFileSync(file, '{not-json'),
      detail: 'scheduled suite emitted no safe completion record',
    },
    {
      name: 'a record for another suite',
      write: (file) =>
        writeFileSync(
          file,
          JSON.stringify({ schemaVersion: 1, suiteId: 'other', status: 0 }),
        ),
      detail: 'invalid scheduled suite completion record',
    },
    {
      name: 'a negative status record',
      write: (file, suiteId) =>
        writeFileSync(
          file,
          JSON.stringify({ schemaVersion: 1, suiteId, status: -1 }),
        ),
      detail: 'invalid scheduled suite completion record',
    },
    {
      name: 'an out-of-range status record',
      write: (file, suiteId) =>
        writeFileSync(
          file,
          JSON.stringify({ schemaVersion: 1, suiteId, status: 256 }),
        ),
      detail: 'invalid scheduled suite completion record',
    },
  ])('stops scheduled execution after $name', async ({ write, detail }) => {
    const suites = [
      runnerSuite(),
      runnerSuite({
        id: 'components.styling',
        currentTarget: 'trinity-e2e-components:styling',
      }),
    ];
    const executed = [];
    const writeReport = vi.fn(() => undefined);

    expect(
      await runSelection('e2e-scheduled', {
        validate: () => [],
        select: () => suites,
        preflight: async () => [],
        executeSuite: (suite, { environment }) => {
          executed.push(suite.id);
          const file = environment[E2E_SAFE_COMPLETION_FILE];
          mkdirSync(join(file, '..'), { recursive: true });
          write(file, suite.id);
          return 0;
        },
        openInvocation: async () => ({
          ...scheduledInvocation(),
          environment: {},
        }),
        readSuiteResult: ({ suiteId } = {}) => ({
          schemaVersion: 1,
          suiteId: suiteId ?? suites[executed.length - 1]?.id,
          status: 'passed',
          attempts: 1,
          retries: 0,
          durationMs: 5,
          attemptDurationMs: 5,
          attemptsByStatus: { passed: 1 },
        }),
        writeReport,
        reportError: () => undefined,
        reportOutput: () => undefined,
      }),
    ).toBe(1);
    expect(executed).toEqual([suites[0].id]);
    expect(writeReport.mock.calls[0][1].suites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: suites[0].id,
          outcome: 'failure',
          detail,
        }),
        expect.objectContaining({ id: suites[1].id, outcome: 'not-run' }),
      ]),
    );
  });

  it('accepts a nonzero nested status when Nx normalizes the outer status', async () => {
    const suites = [
      runnerSuite(),
      runnerSuite({
        id: 'components.styling',
        currentTarget: 'trinity-e2e-components:styling',
      }),
    ];
    const executed = [];
    const writeReport = vi.fn(() => undefined);

    expect(
      await runSelection('e2e-scheduled', {
        validate: () => [],
        select: () => suites,
        preflight: async () => [],
        executeSuite: (suite, { environment }) => {
          executed.push(suite.id);
          writeCompletion(
            environment,
            suite.id,
            suite.id === suites[0].id ? 2 : 0,
          );
          return suite.id === suites[0].id ? 1 : 0;
        },
        openInvocation: async () => ({
          ...scheduledInvocation(),
          environment: {},
        }),
        readSuiteResult: ({ suiteId } = {}) => ({
          schemaVersion: 1,
          suiteId: suiteId ?? suites[executed.length - 1]?.id,
          status: 'passed',
          attempts: 1,
          retries: 0,
          durationMs: 5,
          attemptDurationMs: 5,
          attemptsByStatus: { passed: 1 },
        }),
        writeReport,
        reportError: () => undefined,
        reportOutput: () => undefined,
      }),
    ).toBe(1);
    expect(executed).toEqual(suites.map(({ id }) => id));
  });

  it('stops scheduled suites after aggregate interruption', async () => {
    const suites = [
      runnerSuite(),
      runnerSuite({
        id: 'components.styling',
        currentTarget: 'trinity-e2e-components:styling',
      }),
    ];
    const controller = new AbortController();
    const executed = [];
    const writeReport = vi.fn(() => undefined);

    expect(
      await runSelection('e2e-scheduled', {
        validate: () => [],
        select: () => suites,
        preflight: async () => [],
        executeSuite: ({ id }) => {
          executed.push(id);
          controller.abort();
          return 0;
        },
        createTerminationScope: () => ({
          signal: controller.signal,
          close: () => undefined,
        }),
        openInvocation: async () => ({
          ...scheduledInvocation(),
          environment: {},
          close: async () => undefined,
        }),
        readSuiteResult: () => ({
          schemaVersion: 1,
          suiteId: suites[0].id,
          status: 'passed',
          attempts: 1,
          retries: 0,
          durationMs: 5,
          attemptDurationMs: 5,
          attemptsByStatus: { passed: 1 },
        }),
        writeReport,
        reportError: () => undefined,
        reportOutput: () => undefined,
      }),
    ).toBe(1);
    expect(executed).toEqual([suites[0].id]);
    expect(writeReport.mock.calls[0][1].suites).toContainEqual(
      expect.objectContaining({ id: suites[1].id, outcome: 'not-run' }),
    );
  });

  it('retains the execution failure when partial report publication fails', async () => {
    const reportError = vi.fn();
    expect(
      await runSelection('e2e-scheduled', {
        validate: () => [],
        select: () => [runnerSuite()],
        preflight: async () => [],
        executeSuite: async (_suite, { environment }) => {
          writeCompletion(environment, 'components.storybook', 9);
          return 9;
        },
        openInvocation: async () => ({
          ...scheduledInvocation(),
          environment: {},
          close: async () => undefined,
        }),
        writeReport: () => {
          throw new Error('disk full');
        },
        reportError,
        reportOutput: () => undefined,
      }),
    ).toBe(9);
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining('could not be written'),
    );
  });

  it('fails a successful aggregate when its report cannot be written', async () => {
    expect(
      await runSelection('e2e-scheduled', {
        validate: () => [],
        select: () => [runnerSuite()],
        preflight: async () => [],
        executeSuite: async (_suite, { environment }) => {
          writeCompletion(environment, 'components.storybook', 0);
          return 0;
        },
        openInvocation: async () => ({
          ...scheduledInvocation(),
          environment: {},
          close: async () => undefined,
        }),
        readSuiteResult: () => ({
          schemaVersion: 1,
          suiteId: 'components.storybook',
          status: 'passed',
          attempts: 1,
          retries: 0,
          durationMs: 5,
          attemptDurationMs: 5,
          attemptsByStatus: { passed: 1 },
        }),
        writeReport: () => {
          throw new Error('disk full');
        },
        reportError: () => undefined,
        reportOutput: () => undefined,
      }),
    ).toBe(1);
  });

  it('passes aggregate termination through the owner and every managed child', async () => {
    const controller = new AbortController();
    const closeScope = vi.fn();
    const closeInvocation = vi.fn(async () => undefined);
    const openInvocation = vi.fn(async () => ({
      environment: {},
      close: closeInvocation,
    }));
    const executeSuite = vi.fn(async () => 0);

    expect(
      await runSelection('e2e-components', {
        validate: () => [],
        preflight: async () => [],
        openInvocation,
        executeSuite,
        writeReport: discardReport,
        reportOutput: () => undefined,
        createTerminationScope: () => ({
          signal: controller.signal,
          close: closeScope,
        }),
      }),
    ).toBe(0);
    expect(openInvocation).toHaveBeenCalledWith(
      expect.any(Array),
      controller.signal,
    );
    expect(executeSuite).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(closeInvocation).toHaveBeenCalledOnce();
    expect(closeScope).toHaveBeenCalledOnce();
  });

  it('continues e2e-all with available suites and reports unavailable hosts', async () => {
    const available = runnerSuite();
    const unavailable = runnerSuite({
      id: 'android.installed-webview',
      environment: 'android',
      capabilities: ['composition', 'host'],
      contractTypes: ['host', 'journey'],
      currentTarget: 'trinity-e2e-android:e2e',
      targetProject: 'trinity-e2e-android',
      prerequisites: ['android-avd'],
      availabilityPolicy: 'optional',
      serializationKeys: ['android-avd'],
      timeoutClass: 'host',
    });
    const executeSuite = vi.fn(async () => 0);
    const writeReport = vi.fn(() => undefined);

    expect(
      await runSelection('e2e-all', {
        validate: () => [],
        select: () => [available, unavailable],
        preflight: async ([suite]) =>
          suite.id === unavailable.id ? ['no API 36 emulator'] : [],
        executeSuite,
        openInvocation: async () => ({
          descriptor: { id: 'run-12345678' },
          environment: {},
          close: async () => undefined,
        }),
        readSuiteResult: () => ({
          schemaVersion: 1,
          suiteId: available.id,
          status: 'passed',
          attempts: 1,
          retries: 0,
          durationMs: 5,
          attemptDurationMs: 5,
          attemptsByStatus: { passed: 1 },
        }),
        writeReport,
        reportError: () => undefined,
        reportOutput: () => undefined,
      }),
    ).toBe(0);
    expect(executeSuite).toHaveBeenCalledOnce();
    const report = writeReport.mock.calls[0][1];
    expect(report.suites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: available.id, outcome: 'pass' }),
        expect.objectContaining({ id: unavailable.id, outcome: 'unavailable' }),
      ]),
    );
  });

  it('fails e2e-all before execution when a required suite is unavailable', async () => {
    const required = runnerSuite();
    const executeSuite = vi.fn();
    const writeReport = vi.fn(() => undefined);

    expect(
      await runSelection('e2e-all', {
        validate: () => [],
        select: () => [required],
        preflight: async () => ['browser missing'],
        executeSuite,
        writeReport,
        reportError: () => undefined,
        reportOutput: () => undefined,
      }),
    ).toBe(1);
    expect(executeSuite).not.toHaveBeenCalled();
    expect(writeReport.mock.calls[0][1].suites).toContainEqual(
      expect.objectContaining({
        id: required.id,
        outcome: 'unavailable',
      }),
    );
  });

  it('preflights identical prerequisite sets once per aggregate', async () => {
    const first = runnerSuite({ availabilityPolicy: 'optional' });
    const second = runnerSuite({
      id: 'components.styling',
      currentTarget: 'trinity-e2e-components:styling',
      availabilityPolicy: 'optional',
    });
    const preflight = vi.fn(async () => ['browser missing']);

    expect(
      await runSelection('e2e-all', {
        validate: () => [],
        select: () => [first, second],
        preflight,
        writeReport: discardReport,
        reportError: () => undefined,
        reportOutput: () => undefined,
      }),
    ).toBe(0);
    expect(preflight).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'a missing summary',
      readSuiteResult: () => undefined,
      detail: 'successful suite emitted no execution summary',
    },
    {
      name: 'a mismatched suite identity',
      readSuiteResult: () => ({
        schemaVersion: 1,
        suiteId: 'components.styling',
        status: 'passed',
        attempts: 1,
        retries: 0,
        durationMs: 5,
        attemptDurationMs: 5,
        attemptsByStatus: { passed: 1 },
      }),
      detail: 'suite summary identified components.styling',
    },
    {
      name: 'a non-passing suite status',
      readSuiteResult: () => ({
        schemaVersion: 1,
        suiteId: 'components.storybook',
        status: 'failed',
        attempts: 1,
        retries: 0,
        durationMs: 5,
        attemptDurationMs: 5,
        attemptsByStatus: { failed: 1 },
      }),
      detail: 'suite summary reported failed',
    },
  ])('rejects $name after a zero exit', async ({ readSuiteResult, detail }) => {
    const suite = runnerSuite();
    const writeReport = vi.fn(() => undefined);

    expect(
      await runSelection('e2e-components', {
        validate: () => [],
        select: () => [suite],
        preflight: async () => [],
        executeSuite: async () => 0,
        openInvocation: async () => ({
          descriptor: { id: 'run-12345678' },
          environment: {},
          close: async () => undefined,
        }),
        readSuiteResult,
        writeReport,
        reportError: () => undefined,
        reportOutput: () => undefined,
      }),
    ).toBe(1);
    expect(writeReport.mock.calls[0][1].suites).toContainEqual(
      expect.objectContaining({
        id: suite.id,
        outcome: 'failure',
        detail,
      }),
    );
  });

  it('records invocation teardown failure in the aggregate result', async () => {
    const suite = runnerSuite();
    const writeReport = vi.fn(() => undefined);

    expect(
      await runSelection('e2e-components', {
        validate: () => [],
        select: () => [suite],
        preflight: async () => [],
        executeSuite: async () => 0,
        openInvocation: async () => ({
          descriptor: { id: 'run-12345678' },
          environment: {},
          close: async () => {
            throw new Error('cleanup broke');
          },
        }),
        readSuiteResult: () => ({
          schemaVersion: 1,
          suiteId: suite.id,
          status: 'passed',
          attempts: 1,
          retries: 0,
          durationMs: 5,
          attemptDurationMs: 5,
          attemptsByStatus: { passed: 1 },
        }),
        writeReport,
        reportError: () => undefined,
        reportOutput: () => undefined,
      }),
    ).toBe(1);
    expect(writeReport.mock.calls[0][1].suites).toContainEqual(
      expect.objectContaining({
        id: suite.id,
        outcome: 'failure',
        detail: expect.stringContaining('cleanup broke'),
      }),
    );
  });

  it('distinguishes retries, quarantine and skipped-by-tier outcomes', async () => {
    const retried = runnerSuite();
    const retryReport = vi.fn(() => undefined);
    await runSelection('e2e-components', {
      validate: () => [],
      select: () => [retried],
      preflight: async () => [],
      executeSuite: async () => 0,
      openInvocation: async () => ({
        descriptor: { id: 'run-12345678' },
        environment: {},
        close: async () => undefined,
      }),
      readSuiteResult: () => ({
        schemaVersion: 1,
        suiteId: retried.id,
        status: 'passed',
        attempts: 2,
        retries: 1,
        durationMs: 10,
        attemptDurationMs: 9,
        attemptsByStatus: { failed: 1, passed: 1 },
      }),
      writeReport: retryReport,
      reportError: () => undefined,
      reportOutput: () => undefined,
    });
    expect(retryReport.mock.calls[0][1].suites).toContainEqual(
      expect.objectContaining({ id: retried.id, outcome: 'retry', retries: 1 }),
    );

    const tierReport = vi.fn(() => undefined);
    await runSelection('e2e-pr', {
      validate: () => [],
      select: () => [retried],
      isQuarantined: () => true,
      preflight: vi.fn(),
      openInvocation: vi.fn(),
      writeReport: tierReport,
      reportError: () => undefined,
      reportOutput: () => undefined,
    });
    const tierSuites = tierReport.mock.calls[0][1].suites;
    expect(tierSuites).toContainEqual(
      expect.objectContaining({ id: retried.id, outcome: 'quarantine' }),
    );
    expect(tierSuites).toContainEqual(
      expect.objectContaining({
        id: 'web.production-pwa',
        outcome: 'skipped-by-tier',
      }),
    );
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
