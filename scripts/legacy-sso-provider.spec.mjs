import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactMaestroArtifacts } from '../e2e/android/maestro-session.mts';
import { hasMatrixIdentifier } from '../e2e/support/matrix-identifiers.mts';

const root = resolve(import.meta.dirname, '..');
const providerPath = resolve(root, 'e2e/android/legacy-sso-provider.mts');
const dexReadyFlowPath = resolve(
  root,
  'e2e/android/flows/legacy-sso-dex-ready.yaml',
);
const dexProbeFlowPath = resolve(
  root,
  'e2e/android/flows/legacy-sso-dex-probe.yaml',
);

const chromeNode = (resourceId) =>
  `<node package="com.android.chrome" resource-id="${resourceId}" text="" content-desc="" class="android.view.View" />`;
/** A Custom Tab whose web root is exposed with the Dex form. */
const dexDump = `<hierarchy>${chromeNode('com.android.chrome:id/url_bar')}${chromeNode('login')}${chromeNode('password')}${chromeNode('submit-login')}</hierarchy>`;
/** The hosted failure: Chrome's web root without any child. */
const staleDump = `<hierarchy>${chromeNode('com.android.chrome:id/url_bar')}<node package="com.android.chrome" resource-id="" text="dex" content-desc="" class="android.webkit.WebView" /></hierarchy>`;

/**
 * A device double for the provider's only two boundaries: adb and Maestro.
 * Readiness, probe and fresh-client outcomes are consumed in call order.
 */
function fakeDevice(directory, { ready, probe = [], dumps = [] }) {
  const calls = [];
  const readyOutcomes = [...ready];
  const probeOutcomes = [...probe];
  const dumpOutcomes = [...dumps];
  const device = {
    serial: 'emulator-5554',
    artifactDirectory: directory,
    async adb(...args) {
      calls.push(`adb ${args.join(' ')}`);
      if (args.includes('pm') && args.includes('clear')) return 'Success';
      if (args.includes('uiautomator')) return dumpOutcomes.shift() ?? dexDump;
      return '';
    },
    async runFlow(file) {
      const flow = basename(file);
      calls.push(`flow ${flow}`);
      const outcome =
        flow === 'legacy-sso-dex-ready.yaml'
          ? readyOutcomes.shift()
          : flow === 'legacy-sso-dex-probe.yaml'
            ? probeOutcomes.shift()
            : 'pass';
      if (outcome === undefined) throw new Error(`unscripted ${flow}`);
      if (outcome === 'miss')
        throw new Error(
          `Maestro ${flow} failed (1); diagnostics: ${directory}`,
        );
    },
  };
  return { calls, device };
}

async function openProvider(directory, script, options = {}) {
  const { openLegacySsoProvider } = await import(providerPath);
  const { calls, device } = fakeDevice(directory, script);
  const launches = [];
  const provider = await openLegacySsoProvider(
    device,
    root,
    directory,
    new AbortController().signal,
    { reloadSettleMs: 0, ...options },
  );
  const launch = async (attempt) => {
    launches.push(attempt);
    calls.push(`launch ${attempt}`);
  };
  return { calls, launches, launch, provider };
}

const readRecovery = async (directory) =>
  JSON.parse(await readFile(join(directory, 'dex-recovery.json'), 'utf8'));

/** Assert `expected` appears in `calls` in this order, other calls allowed between. */
function expectOrdered(calls, expected) {
  let cursor = 0;
  for (const step of expected) {
    const index = calls.findIndex(
      (call, position) => position >= cursor && call.includes(step),
    );
    expect(
      index,
      `${step} after call ${cursor} in\n${calls.join('\n')}`,
    ).toBeGreaterThanOrEqual(0);
    cursor = index + 1;
  }
}

describe('Android legacy SSO Dex readiness recovery', () => {
  let directory;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'trinity-dex-recovery-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('caps the Dex readiness wait at 30 s and probes with a short fresh-session wait', () => {
    const ready = readFileSync(dexReadyFlowPath, 'utf8');
    expect(ready).toMatch(
      /- extendedWaitUntil:\n {4}visible:\n {6}id: login\n {4}timeout: 30000\n/u,
    );
    expect(ready).not.toContain('180000');
    expect(dexProbeFlowPath, 'legacy-sso-dex-probe.yaml must exist').toSatisfy(
      existsSync,
    );
    const probe = readFileSync(dexProbeFlowPath, 'utf8');
    expect(probe).toContain('appId: com.android.chrome');
    expect(probe).toMatch(
      /- extendedWaitUntil:\n {4}visible:\n {6}id: login\n {4}timeout: 5000\n/u,
    );
    expect(probe).not.toContain('tapOn');
  });

  it('opens Dex through one launch when the first wait finds the form', async () => {
    const { calls, launches, launch, provider } = await openProvider(
      directory,
      { ready: ['pass'] },
    );
    await expect(provider.start(launch)).resolves.toMatchObject({
      package: 'com.android.chrome',
      hasLogin: true,
    });
    expect(launches).toEqual([1]);
    expect(calls.filter((call) => call.includes('dex-probe'))).toEqual([]);
    expect(await readdir(directory)).not.toContain('dex-recovery.json');
  });

  it('probes a stale tree in order, then recovers exactly once from a clean Chrome', async () => {
    const { calls, launches, launch, provider } = await openProvider(
      directory,
      {
        ready: ['miss', 'pass'],
        probe: ['miss'],
        dumps: [staleDump, dexDump],
      },
    );
    await expect(provider.start(launch)).resolves.toMatchObject({
      hasLogin: true,
    });
    expect(launches).toEqual([1, 2]);
    expectOrdered(calls, [
      'adb shell am force-stop com.android.chrome',
      'adb shell pm clear com.android.chrome',
      'flow legacy-sso-chrome-setup.yaml',
      'launch 1',
      'flow legacy-sso-dex-ready.yaml',
      'flow legacy-sso-dex-probe.yaml',
      'adb exec-out uiautomator dump /dev/tty',
      'adb shell input keyevent KEYCODE_F5',
      'adb exec-out uiautomator dump /dev/tty',
      'adb shell am force-stop com.android.chrome',
      'adb shell pm clear com.android.chrome',
      'flow legacy-sso-chrome-setup.yaml',
      'launch 2',
      'flow legacy-sso-dex-ready.yaml',
    ]);
    expect(
      calls.filter((call) => call === 'flow legacy-sso-dex-ready.yaml'),
    ).toHaveLength(2);
    expect(
      calls.filter((call) => call === 'flow legacy-sso-dex-probe.yaml'),
    ).toHaveLength(1);

    const [record] = await readRecovery(directory);
    expect(record).toMatchObject({
      forced: false,
      attempts: 2,
      recovered: true,
      probe: [
        { step: 'maestro', content: false },
        { step: 'fresh-client', content: false },
        { step: 'after-reload', content: true },
      ],
      firstContentStep: 'after-reload',
    });
    const fresh = record.probe[1].artifact;
    const reloaded = record.probe[2].artifact;
    expect(await readFile(join(directory, fresh), 'utf8')).toBe(staleDump);
    expect(await readFile(join(directory, reloaded), 'utf8')).toBe(dexDump);
  });

  it('registers the replaced SSO state before the probe writes anything', async () => {
    const { calls, device } = fakeDevice(directory, {
      ready: ['miss', 'pass'],
      probe: ['miss'],
      dumps: [staleDump, dexDump],
    });
    let registered = false;
    const probeStepsBeforeRegistration = [];
    const guardedDevice = {
      ...device,
      async runFlow(file, variables) {
        if (basename(file) === 'legacy-sso-dex-probe.yaml' && !registered)
          probeStepsBeforeRegistration.push(basename(file));
        return device.runFlow(file, variables);
      },
      async adb(...args) {
        if (args.includes('uiautomator') && missed && !registered)
          probeStepsBeforeRegistration.push(args.join(' '));
        return device.adb(...args);
      },
    };
    let missed = false;
    const { openLegacySsoProvider } = await import(providerPath);
    const provider = await openLegacySsoProvider(
      guardedDevice,
      root,
      directory,
      new AbortController().signal,
      { reloadSettleMs: 0 },
    );
    const launch = Object.assign(
      async (attempt) => {
        calls.push(`launch ${attempt}`);
        if (attempt === 1) missed = true;
      },
      {
        beforeProbe: async () => {
          calls.push('beforeProbe');
          registered = true;
        },
      },
    );
    await provider.start(launch);
    expect(missed).toBe(true);
    expect(
      probeStepsBeforeRegistration,
      'probe steps that ran before the replaced SSO state was registered',
    ).toEqual([]);
    expect(registered, 'beforeProbe ran on the miss').toBe(true);
    expectOrdered(calls, [
      'launch 1',
      'flow legacy-sso-dex-ready.yaml',
      'beforeProbe',
      'flow legacy-sso-dex-probe.yaml',
      'launch 2',
    ]);
    expect(calls.filter((call) => call === 'beforeProbe')).toHaveLength(1);
  });

  it('fails on a second miss and keeps the first attempt diagnostics', async () => {
    const { calls, launches, launch, provider } = await openProvider(
      directory,
      {
        ready: ['miss', 'miss'],
        probe: ['miss'],
        dumps: [staleDump, staleDump],
      },
    );
    await expect(provider.start(launch)).rejects.toThrow(
      /Dex readiness missed on both attempts/u,
    );
    expect(launches).toEqual([1, 2]);
    expect(
      calls.filter((call) => call === 'flow legacy-sso-dex-ready.yaml'),
    ).toHaveLength(2);
    expect(
      calls.filter((call) => call === 'flow legacy-sso-dex-probe.yaml'),
    ).toHaveLength(1);
    const [record] = await readRecovery(directory);
    expect(record).toMatchObject({
      attempts: 2,
      recovered: false,
      firstContentStep: null,
    });
    for (const { artifact } of record.probe.slice(1)) {
      expect(await readFile(join(directory, artifact), 'utf8')).toBe(staleDump);
    }
  });

  it('can force the first wait to miss so the recovery runs end to end', async () => {
    const { launches, launch, provider } = await openProvider(
      directory,
      { ready: ['pass', 'pass'], probe: ['pass'] },
      { forceFirstDexMiss: true },
    );
    await provider.start(launch);
    expect(launches).toEqual([1, 2]);
    const [record] = await readRecovery(directory);
    expect(record).toMatchObject({
      forced: true,
      recovered: true,
      firstContentStep: 'maestro',
    });
  });

  it('keeps probe dumps under the suite artifacts that the registered secrets redact', async () => {
    const email = 'sso-probe@trinity.test';
    const password = 'probe-dex-password';
    const leaking = `<hierarchy>${chromeNode('login')}<node package="com.android.chrome" text="${email}" /><node package="com.android.chrome" text="${password}" /></hierarchy>`;
    const { launch, provider } = await openProvider(directory, {
      ready: ['miss', 'pass'],
      probe: ['miss'],
      dumps: [leaking, leaking],
    });
    await provider.start(launch);
    const [record] = await readRecovery(directory);
    for (const { artifact } of record.probe.slice(1)) {
      expect(artifact).not.toMatch(/^\.\.|\//u);
    }
    await redactMaestroArtifacts(directory, {
      DEX_EMAIL_SECRET: email,
      DEX_PASSWORD: password,
    });
    for (const name of await readdir(directory)) {
      const text = await readFile(join(directory, name), 'utf8');
      expect(text, name).not.toContain(email);
      expect(text, name).not.toContain(password);
      expect(hasMatrixIdentifier(text), name).toBe(false);
    }
  });
});

describe('Android legacy SSO journey launch contract', () => {
  const journey = readFileSync(
    resolve(root, 'e2e/android/legacy-sso-journeys.mts'),
    'utf8',
  );

  it('opens every provider through the re-launch callback at three call sites', () => {
    expect(
      journey.split('ssoLaunch(client, device, secrets, signal)'),
    ).toHaveLength(4);
    expect(journey).not.toMatch(/\.prepare\(\)|\.waitForDex\(\)/u);
    expect(journey).toMatch(
      /async function startLegitimateSso\([\s\S]*?launch: DexLaunch,[\s\S]*?await provider\.start\(launch\);/u,
    );
    expect(journey).toMatch(
      /await provider\.start\(\s*ssoLaunch\(client, device, secrets, signal\),?\s*\)/u,
    );
    expect(
      journey.split("exactText: 'Continue with SSO' })").length - 1,
      'one Continue with SSO tap, inside the launch callback',
    ).toBe(1);
  });

  it('routes every other provider consumer through the recovering start', () => {
    const consumers = readdirSync(resolve(root, 'e2e/android'))
      .filter((name) => name.endsWith('.mts'))
      .map((name) => [
        name,
        readFileSync(resolve(root, 'e2e/android', name), 'utf8'),
      ])
      .filter(
        ([name, text]) =>
          name !== 'legacy-sso-provider.mts' &&
          text.includes('openLegacySsoProvider('),
      );
    expect(consumers.map(([name]) => name).sort()).toEqual([
      'legacy-sso-journeys.mts',
      'sso-recovery-reset-journeys.mts',
    ]);
    for (const [name, text] of consumers) {
      expect(text, name).toContain('provider.start(');
      expect(text, name).not.toMatch(/provider\.(?:prepare|waitForDex)\(/u);
    }
  });

  it('registers the Dex credentials before any flow and each superseded SSO state', () => {
    const registration = journey.indexOf(
      'secrets.DEX_EMAIL_SECRET = sso.email',
    );
    expect(registration).toBeGreaterThanOrEqual(0);
    expect(journey.indexOf('secrets.DEX_PASSWORD = sso.pass')).toBeGreaterThan(
      registration,
    );
    expect(journey.indexOf('await openMaestroDevice(')).toBeGreaterThan(
      registration,
    );
    expect(journey).toMatch(
      /function ssoLaunch\([\s\S]*?beforeProbe: async \(\) => \{\s*secrets\[\s*`SSO_STATE_SECRET_SUPERSEDED_\$\{[^`]+\}`\s*\] = await readPersistedSsoState\(device, signal\);/u,
    );
    expect(journey).not.toContain('attempt > 1');
  });
});
