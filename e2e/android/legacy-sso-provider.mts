import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { MaestroDevice } from './maestro-session.mts';

const CHROME_PACKAGE = 'com.android.chrome';
const TRINITY_COMPONENT =
  'eu.qwky.trinity/eu.qwky.trinity.MainActivity';
const CHROME_COMMAND_LINE = '/data/local/tmp/chrome-command-line';
const CHROME_FLAGS = [
  '_',
  '--disable-fre',
  '--no-default-browser-check',
  '--ignore-certificate-errors',
  '--host-resolver-rules=MAP localhost 127.0.0.1',
] as const;

interface NativeNode {
  readonly package: string;
  readonly resourceId: string;
  readonly text: string;
  readonly contentDescription: string;
  readonly className: string;
}

export interface DexSurfaceProof {
  readonly package: typeof CHROME_PACKAGE;
  readonly hasLogin: true;
  readonly hasPassword: true;
  readonly hasSubmit: true;
}

export interface DexCompletionProof extends DexSurfaceProof {
  readonly nativeActions: readonly ['email', 'password', 'submit'];
}

/** Opens the provider from Trinity; attempt 2 is the one recovery launch. */
export interface DexLaunch {
  (attempt: 1 | 2): Promise<void>;
  /**
   * Runs once on a miss, before the stale-state probe writes any artifact, so
   * state that the recovery launch will replace is registered as a secret first.
   */
  readonly beforeProbe?: () => Promise<void>;
}

export interface LegacySsoProviderOptions {
  /** Test hook: treat the first readiness wait as a miss to run the recovery. */
  readonly forceFirstDexMiss?: boolean;
  /** Time for Chrome to reload the Dex page before the last probe dump. */
  readonly reloadSettleMs?: number;
}

type DexProbeStep = 'maestro' | 'fresh-client' | 'after-reload';

interface DexProbeResult {
  readonly step: DexProbeStep;
  readonly content: boolean;
  readonly artifact: string;
}

/** One entry of `dex-recovery.json`. */
interface DexRecoveryRecord {
  readonly forced: boolean;
  readonly attempts: 2;
  readonly probe: readonly DexProbeResult[];
  readonly firstContentStep: DexProbeStep | null;
  readonly recovered: boolean;
}

export interface LegacySsoProvider {
  /**
   * Prepare Chrome, open Dex through `launch` and wait for its form. A miss is
   * probed, then recovered exactly once from a clean Chrome; a second miss fails.
   */
  start(launch: DexLaunch): Promise<DexSurfaceProof>;
  completeDexSignIn(
    email: string,
    password: string,
  ): Promise<DexCompletionProof>;
  close(): Promise<void>;
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function nativeNodes(hierarchy: string): readonly NativeNode[] {
  return [...hierarchy.matchAll(/<node\b[^>]+>/gu)].map(([node]) => {
    const attributes = Object.fromEntries(
      [...node.matchAll(/([\w-]+)="([^"]*)"/gu)].map(([, key, value]) => [
        key,
        decodeXml(value ?? ''),
      ]),
    );
    return {
      package: attributes['package'] ?? '',
      resourceId: attributes['resource-id'] ?? '',
      text: attributes['text'] ?? '',
      contentDescription: attributes['content-desc'] ?? '',
      className: attributes['class'] ?? '',
    };
  });
}

const hasDexLogin = (hierarchy: string): boolean =>
  nativeNodes(hierarchy).some(
    (node) => node.package === CHROME_PACKAGE && node.resourceId === 'login',
  );

// Consumed by the first provider of the process only, so one forced miss
// exercises the recovery without multiplying the suite's duration.
let forcedDexMissPending =
  process.env['TRINITY_E2E_LEGACY_SSO_FORCE_DEX_MISS'] === '1';

async function waitForDexSurface(
  device: MaestroDevice,
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<DexSurfaceProof> {
  signal.throwIfAborted();
  await device.runFlow(
    join(workspaceRoot, 'e2e/android/flows/legacy-sso-dex-ready.yaml'),
  );
  signal.throwIfAborted();
  const hierarchy = await device.adb(
    'exec-out',
    'uiautomator',
    'dump',
    '/dev/tty',
  );
  assert(
    nativeNodes(hierarchy).some((node) => node.package === CHROME_PACKAGE),
    'Dex surface is hosted by the native Chrome package',
  );
  return {
    package: CHROME_PACKAGE,
    hasLogin: true,
    hasPassword: true,
    hasSubmit: true,
  };
}

export async function openLegacySsoProvider(
  device: MaestroDevice,
  workspaceRoot: string,
  artifactDirectory: string,
  signal: AbortSignal,
  options: LegacySsoProviderOptions = {},
): Promise<LegacySsoProvider> {
  let commandLinePresent = false;
  let closed = false;
  let prepared = false;
  let started = false;

  const removeChromeCommandLine = async (): Promise<void> => {
    if (!commandLinePresent) return;
    await device.adb('shell', 'rm', '-f', CHROME_COMMAND_LINE);
    commandLinePresent = false;
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    try {
      await removeChromeCommandLine();
    } catch (error) {
      failures.push(error);
    }
    try {
      await device.adb('shell', 'am', 'force-stop', CHROME_PACKAGE);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) {
      throw new AggregateError(failures, 'Chrome provider cleanup failed');
    }
  };

  // A readiness flow shows the Dex form within 0.22 s of the certificate
  // bypass on every passing hosted run, while a stale Chrome web tree (a root
  // with no children) never recovers in the same Custom Tab, so the flow waits
  // 30 s for the form. This signal bounds the whole attempt instead: Maestro
  // start-up plus the certificate-warning taps, whose hierarchy reads may each
  // spend up to 10 s on DevTools augmentation before the 30 s wait begins.
  const waitForDex = async (): Promise<DexSurfaceProof> => {
    assert(prepared, 'SSO provider must be prepared before Dex observation');
    return waitForDexSurface(
      device,
      workspaceRoot,
      AbortSignal.any([signal, AbortSignal.timeout(240_000)]),
    );
  };

  const probeId = randomUUID().slice(0, 8);
  const freshClientDump = async (
    step: DexProbeStep,
  ): Promise<DexProbeResult> => {
    const artifact = `dex-probe-${probeId}-${step}.xml`;
    try {
      const hierarchy = await device.adb(
        'exec-out',
        'uiautomator',
        'dump',
        '/dev/tty',
      );
      await writeFile(join(artifactDirectory, artifact), hierarchy);
      return { step, content: hasDexLogin(hierarchy), artifact };
    } catch {
      return { step, content: false, artifact };
    }
  };

  /**
   * Capture the stale state before recovery destroys it: a fresh Maestro
   * session, a fresh UIAutomator client, then the same client after a reload.
   */
  const probeStaleDex = async (): Promise<readonly DexProbeResult[]> => {
    let maestro = true;
    try {
      await device.runFlow(
        join(workspaceRoot, 'e2e/android/flows/legacy-sso-dex-probe.yaml'),
      );
    } catch {
      maestro = false;
    }
    const probe: DexProbeResult[] = [
      { step: 'maestro', content: maestro, artifact: 'legacy-sso-dex-probe-*' },
      await freshClientDump('fresh-client'),
    ];
    await device
      .adb('shell', 'input', 'keyevent', 'KEYCODE_F5')
      .catch(() => undefined);
    await delay(options.reloadSettleMs ?? 10_000, undefined, { signal });
    probe.push(await freshClientDump('after-reload'));
    return probe;
  };

  const recordRecovery = async (record: DexRecoveryRecord): Promise<void> => {
    const file = join(artifactDirectory, 'dex-recovery.json');
    const records: unknown[] = JSON.parse(
      await readFile(file, 'utf8').catch(() => '[]'),
    );
    await writeFile(file, `${JSON.stringify([...records, record], null, 2)}\n`);
  };

  signal.addEventListener(
    'abort',
    () => {
      void close().catch(() => undefined);
    },
    { once: true },
  );

  const prepare = async (): Promise<void> => {
    assert(!closed, 'Cannot prepare a closed SSO provider');
    signal.throwIfAborted();
    const failures: unknown[] = [];
    try {
      await device.adb('shell', 'am', 'force-stop', CHROME_PACKAGE);
      assert.equal(
        await device.adb('shell', 'pm', 'clear', CHROME_PACKAGE),
        'Success',
        'Disposable Chrome profile cleared',
      );
      const encoded = Buffer.from(CHROME_FLAGS.join(' ')).toString('base64');
      commandLinePresent = true;
      await device.adb(
        'shell',
        'sh',
        '-c',
        `echo ${encoded} | base64 -d > ${CHROME_COMMAND_LINE}`,
      );
      await device.adb(
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        'about:blank',
        CHROME_PACKAGE,
      );
      await device.runFlow(
        join(
          workspaceRoot,
          'e2e/android/flows/legacy-sso-chrome-setup.yaml',
        ),
      );
      await removeChromeCommandLine();
      await device.adb(
        'shell',
        'am',
        'start',
        '-W',
        '-n',
        TRINITY_COMPONENT,
      );
      prepared = true;
      await writeFile(
        join(artifactDirectory, 'chrome-provider.json'),
        `${JSON.stringify(
          {
            package: CHROME_PACKAGE,
            profileCleared: true,
            commandLineFirstRunBypassRequested: true,
            firstRunHandledNatively: true,
            loopbackIpv4: true,
            disposableCertificateAccepted: true,
            driverInstalled: false,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await removeChromeCommandLine();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) {
      throw new AggregateError(
        failures,
        'Chrome provider preparation failed',
      );
    }
  };

  const start = async (launch: DexLaunch): Promise<DexSurfaceProof> => {
    assert(!started, 'Dex is opened once per SSO provider');
    started = true;
    await prepare();
    await launch(1);
    const forced = options.forceFirstDexMiss ?? forcedDexMissPending;
    forcedDexMissPending = false;
    let firstMiss: unknown;
    try {
      const surface = await waitForDex();
      if (!forced) return surface;
      firstMiss = new Error('Forced first Dex readiness miss');
    } catch (error) {
      signal.throwIfAborted();
      firstMiss = error;
    }
    await launch.beforeProbe?.();
    const probe = await probeStaleDex();
    const record = {
      forced,
      attempts: 2,
      probe,
      firstContentStep: probe.find((result) => result.content)?.step ?? null,
    } as const;
    try {
      await prepare();
      await launch(2);
      const surface = await waitForDex();
      await recordRecovery({ ...record, recovered: true });
      return surface;
    } catch (secondMiss) {
      await recordRecovery({ ...record, recovered: false });
      throw new AggregateError(
        [firstMiss, secondMiss],
        'Dex readiness missed on both attempts; the first miss is probed in dex-recovery.json',
      );
    }
  };

  return {
    start,
    async completeDexSignIn(email, password) {
      const surface = await waitForDex();
      await device.runFlow(
        join(workspaceRoot, 'e2e/android/flows/legacy-sso-dex.yaml'),
        { DEX_EMAIL_SECRET: email, DEX_PASSWORD: password },
      );
      return {
        ...surface,
        nativeActions: ['email', 'password', 'submit'],
      };
    },
    close,
  };
}
