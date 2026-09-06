import { execFile } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  expect,
  test as base,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { _android, type AndroidDevice } from 'playwright';
import { findTriggeredExternalPage } from '../support/external-page.mts';
import {
  ANDROID_SURFACE_INITIAL_TIMEOUT_MS,
  ANDROID_SURFACE_RECOVERY_TIMEOUT_MS,
  ANDROID_INFRASTRUCTURE_FAILURE,
  type AndroidApplicationSurfaceState,
  type AndroidInfrastructureFailure,
  type AndroidInfrastructureLayer,
  isAndroidWebViewProbeUnavailable,
  isPlaywrightTargetLoss,
  runAndroidInfrastructureOperation,
  stabilizeApplicationSurface,
  trinityCrashProcessNames,
} from './health.mts';
import { navigateApplication } from '../support/navigation.mts';
import { setAndroidTouchViewport, touchAndroidControl } from './touch.mts';
import { resourceFixtureDefinitions } from '../support/resource-fixtures.mts';
import type {
  AuthCallbackKind,
  AuthPlatform,
  Navigate,
  TouchPlatform,
} from '../support/platform-contracts.mts';

const packageName = 'eu.qwky.trinity';
const secondaryPackageName = 'eu.qwky.trinity.secondary';
const appOrigin = 'https://localhost';
const exec = promisify(execFile);
type AndroidWebView = ReturnType<AndroidDevice['webViews']>[number];
const attachedWebViews = new WeakSet<AndroidWebView>();

function infrastructureFailure(
  layer: AndroidInfrastructureLayer,
  summary: string,
): Error {
  const failure: AndroidInfrastructureFailure = {
    kind: ANDROID_INFRASTRUCTURE_FAILURE,
    version: 1,
    layer,
    serial: process.env['TRINITY_ANDROID_SERIAL'] ?? '<unknown>',
    summary,
    recordedAt: new Date().toISOString(),
  };
  const marker = process.env['TRINITY_ANDROID_FATAL_MARKER'];
  if (marker) {
    try {
      writeFileSync(marker, `${JSON.stringify(failure, null, 2)}\n`, {
        flag: 'wx',
      });
    } catch {
      // The original infrastructure error is more useful than a secondary
      // artifact-write failure; the outer runner still has adb diagnostics.
    }
  }
  return new Error(`${failure.kind}: ${failure.layer}: ${failure.summary}`);
}

async function shell(device: AndroidDevice, command: string): Promise<string> {
  try {
    return (await device.shell(command)).toString('utf8').trim();
  } catch {
    throw infrastructureFailure(
      'playwright-driver',
      'Playwright lost the Android shell transport',
    );
  }
}

async function readApplicationSurfaceState(
  page: Page,
): Promise<AndroidApplicationSurfaceState> {
  return page.evaluate<AndroidApplicationSurfaceState>(() => {
    if (document.querySelector('.trn-boot')) return 'static-boot';
    if (document.querySelector('[data-testid="app-startup-blocked"]'))
      return 'runtime-blocked';
    if (document.querySelector('[data-testid="app-booting"]'))
      return 'runtime-restoring';
    const outlet = document.querySelector('router-outlet');
    const routedSurface = outlet?.nextElementSibling;
    if (!routedSurface || routedSurface.matches('trn-verification-host')) {
      return 'route-empty';
    }
    return 'ready';
  });
}

async function inspectApplicationReadySurface(
  page: Page,
  description: string,
  timeout: number,
): Promise<AndroidApplicationSurfaceState> {
  let lastState: AndroidApplicationSurfaceState = 'static-boot';
  try {
    await expect
      .poll(
        async () => {
          lastState = await readApplicationSurfaceState(page);
          return lastState;
        },
        {
          message: `${description} must reach a finite routed application surface`,
          timeout,
        },
      )
      .toBe('ready');
    return 'ready';
  } catch {
    try {
      return await readApplicationSurfaceState(page);
    } catch {
      throw infrastructureFailure(
        'playwright-driver',
        `${description} could not inspect the Android WebView`,
      );
    }
  }
}

async function runApplicationWebViewOperation<T>(
  page: Page,
  operation: () => Promise<T>,
  description: string,
): Promise<T> {
  return runAndroidInfrastructureOperation(
    operation,
    async (error) => {
      if (page.isClosed() || isPlaywrightTargetLoss(error)) return true;
      return (
        page.isClosed() ||
        (await isAndroidWebViewProbeUnavailable(() =>
          page.evaluate(() => true),
        ))
      );
    },
    () =>
      infrastructureFailure(
        'application-webview',
        `${description} could not complete in the installed WebView`,
      ),
  );
}

async function waitForApplicationReadySurface(
  page: Page,
  description: string,
  recover?: () => Promise<void>,
): Promise<void> {
  let inspection = 0;
  const result = await stabilizeApplicationSurface(
    () =>
      inspectApplicationReadySurface(
        page,
        description,
        recover && inspection++ === 0
          ? ANDROID_SURFACE_INITIAL_TIMEOUT_MS
          : ANDROID_SURFACE_RECOVERY_TIMEOUT_MS,
      ),
    recover,
  );
  if (result.state !== 'ready') {
    throw infrastructureFailure(
      'application-surface',
      `${description} did not become ready${result.recovered ? ' after one document recovery' : ''} ` +
        `(last state: ${result.state})`,
    );
  }
}

async function waitForActivatedApplicationPage(
  page: Page,
  description: string,
): Promise<void> {
  await runApplicationWebViewOperation(
    page,
    () => page.waitForLoadState('domcontentloaded'),
    description,
  );
  await waitForApplicationReadySurface(page, description);
}

function configureApplicationNavigation(page: Page, description: string): void {
  const originalGoto = page.goto.bind(page);
  const originalReload = page.reload.bind(page);

  page.reload = async (reloadOptions) => {
    let response = await runApplicationWebViewOperation(
      page,
      () => originalReload(reloadOptions),
      `${description} reload`,
    );
    await waitForApplicationReadySurface(
      page,
      `${description} reload`,
      async () => {
        response = await runApplicationWebViewOperation(
          page,
          () => originalReload({ waitUntil: 'domcontentloaded' }),
          `${description} recovery reload`,
        );
      },
    );
    return response;
  };
  page.goto = async (url, gotoOptions) => {
    let response = await runApplicationWebViewOperation(
      page,
      () => originalGoto(new URL(url, appOrigin).href, gotoOptions),
      `${description} navigation`,
    );
    await waitForApplicationReadySurface(
      page,
      `${description} navigation`,
      async () => {
        // Android System WebView occasionally commits the local HTTPS document
        // without executing its module scripts, or leaves Application Runtime
        // restoring after sustained load. One fresh document is the bounded
        // host recovery; any second stall remains a classified suite failure.
        response = await runApplicationWebViewOperation(
          page,
          () => originalReload({ waitUntil: 'domcontentloaded' }),
          `${description} navigation recovery`,
        );
      },
    );
    return response;
  };
}

async function clearPackageData(
  device: AndroidDevice,
  pkg: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await shell(device, `am force-stop ${pkg}`);
    const result = await shell(device, `pm clear ${pkg}`);
    if (result !== 'Success') {
      throw new Error(`pm clear ${pkg} failed: ${result || '<empty output>'}`);
    }
    const [pid, residualPreferences] = await Promise.all([
      shell(device, `pidof ${pkg}`),
      shell(
        device,
        `run-as ${pkg} find shared_prefs -type f -print 2>/dev/null`,
      ),
    ]);
    if (!pid && !residualPreferences) return;
  }
  throw new Error(
    `pm clear ${pkg} left a running process or preferences behind`,
  );
}

async function waitForDurableActiveAccount(
  device: AndroidDevice,
  pkg: string,
  accountId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  const expected = `activeUserId&quot;:&quot;${accountId}`;
  let registry = '';
  while (Date.now() < deadline) {
    registry = await shell(
      device,
      `run-as ${pkg} cat shared_prefs/CapacitorStorage.xml 2>/dev/null`,
    );
    if (registry.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Active Account ${accountId} was not durable before process restart; ` +
      `preferences=${registry || '<empty>'}`,
  );
}

async function setEmulatorLocation(
  device: AndroidDevice,
  position: { latitude: number; longitude: number },
): Promise<void> {
  await shell(
    device,
    `cmd location providers set-test-provider-location gps --location ${position.latitude},${position.longitude} --accuracy 1`,
  );
}

async function enableSelfSignedTls(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send('Security.setIgnoreCertificateErrors', { ignore: true });
}

async function launchApp(
  device: AndroidDevice,
  excludedWebViews: ReadonlySet<AndroidWebView> = new Set(),
): Promise<{ page: Page; pid: number }> {
  return launchPackage(
    device,
    packageName,
    `${packageName}/.MainActivity`,
    excludedWebViews,
  );
}

async function launchPackage(
  device: AndroidDevice,
  pkg: string,
  component: string,
  excludedWebViews: ReadonlySet<AndroidWebView> = new Set(),
): Promise<{ page: Page; pid: number }> {
  const staleWebViews = new Set(excludedWebViews);
  let startOutput = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const launchedAfter = Date.now() - 1_000;
    startOutput = await shell(device, `am start -W -n ${component}`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const livePids = new Set(
        (await shell(device, `pidof ${pkg}`))
          .split(/\s+/)
          .map(Number)
          .filter(Number.isFinite),
      );
      const candidates = device
        .webViews()
        .filter(
          (candidate) =>
            candidate.pkg() === pkg &&
            livePids.has(candidate.pid()) &&
            !attachedWebViews.has(candidate) &&
            !staleWebViews.has(candidate),
        );
      for (const webView of candidates) {
        try {
          const page = await webView.page();
          const documentCreatedAt = await page.evaluate(
            () => performance.timeOrigin,
          );
          attachedWebViews.add(webView);
          // Playwright's Android driver may retain a closed target after Android
          // rapidly reuses its PID. The driver can materialize that target as a new
          // wrapper, so object identity and live pid checks are not enough. A real
          // WebView for this Activity launch necessarily owns a new document epoch.
          if (documentCreatedAt < launchedAfter) continue;
          await enableSelfSignedTls(page);
          await page.waitForLoadState('domcontentloaded');
          return { page, pid: webView.pid() };
        } catch {
          staleWebViews.add(webView);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    for (const candidate of device.webViews()) staleWebViews.add(candidate);
    await shell(device, `am force-stop ${pkg}`);
  }
  const livePids = await shell(device, `pidof ${pkg}`);
  const webViews = device
    .webViews()
    .map((candidate) => `${candidate.pkg()}:${candidate.pid()}`)
    .join(', ');
  throw infrastructureFailure(
    'application-webview',
    `No ${pkg} WebView appeared after two launches; ` +
      `pidof=${livePids || '<none>'}; webviews=${webViews || '<none>'}; ` +
      `am-start=${startOutput || '<empty>'}`,
  );
}

interface AndroidApp {
  device: AndroidDevice;
  readonly page: Page;
  navigate: Navigate;
  inputText(text: string): Promise<void>;
  pressKey(keyCode: number): Promise<void>;
  pressBack(): Promise<void>;
  touch(control: Locator): Promise<void>;
  relaunch(): Promise<Page>;
}

interface AndroidFixtures {
  app: AndroidApp;
  authPlatform: AuthPlatform;
  touchPlatform: TouchPlatform;
  secondaryApp: {
    launch(): Promise<Page>;
    activatePrimary(): Promise<void>;
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function nativeCallbackUrl(
  appPage: Page,
  callbackPath: string,
  kind: AuthCallbackKind,
): string {
  const callback = new URL(callbackPath, appPage.url());
  const prefix =
    kind === 'oidc'
      ? 'eu.qwky.trinity:/sso-callback'
      : 'eu.qwky.trinity://sso-callback';
  return `${prefix}${callback.search}`;
}

interface AndroidWorkerFixtures {
  androidDevice: AndroidDevice;
}

interface AndroidUseOptions {
  colorScheme: 'dark' | 'light' | 'no-preference' | null;
  deviceScaleFactor: number | undefined;
  geolocation:
    { latitude: number; longitude: number; accuracy?: number } | undefined;
  hasTouch: boolean;
  isMobile: boolean;
  launchOptions: { args?: string[] };
  permissions: string[];
  userAgent: string | undefined;
  viewport: { width: number; height: number } | null;
}

async function configurePage(
  device: AndroidDevice,
  page: Page,
  options: AndroidUseOptions,
): Promise<() => Promise<void>> {
  configureApplicationNavigation(page, 'Android WebView');

  const session = await page.context().newCDPSession(page);
  let currentViewport: AndroidUseOptions['viewport'] = null;
  const applyViewport = async (viewport: { width: number; height: number }) => {
    if (
      currentViewport?.width === viewport.width &&
      currentViewport.height === viewport.height
    ) {
      // Native Chromium rounds device scale ratios through single-precision values.
      const unchanged = await page.evaluate(
        ({ width, height, dpr }) =>
          innerWidth === width &&
          innerHeight === height &&
          Math.abs(devicePixelRatio - dpr) < 1e-6,
        { ...viewport, dpr: options.deviceScaleFactor ?? 1 },
      );
      if (unchanged) return;
    }
    // Screenshot capture restores another CDP session's metrics. Clear our cached
    // override first so reapplying the same requested size reaches the WebView.
    await session.send('Emulation.clearDeviceMetricsOverride');
    const physical = await session.send('Page.getLayoutMetrics');
    const scale = Math.min(
      1,
      physical.cssVisualViewport.clientWidth / viewport.width,
    );
    const applyScale = async (scale: number): Promise<void> => {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: options.deviceScaleFactor ?? 1,
        mobile: options.isMobile,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
        scale,
      });
    };
    // The viewport owner retains this session: detaching a temporary emulation session
    // would clear the metrics and trigger the phone layout after a wide-layout tap.
    setAndroidTouchViewport(page, { scale, applyScale });
    await applyScale(1);
    currentViewport = viewport;
  };
  if (options.viewport) {
    await applyViewport(options.viewport);
  }
  page.viewportSize = () => currentViewport;
  page.setViewportSize = applyViewport;
  await session.send('Emulation.setTouchEmulationEnabled', {
    enabled: options.hasTouch,
    maxTouchPoints: options.hasTouch ? 5 : 1,
  });
  if (options.userAgent) {
    await session.send('Network.setUserAgentOverride', {
      userAgent: options.userAgent,
    });
  }
  if (options.colorScheme) {
    await page.emulateMedia({ colorScheme: options.colorScheme });
  }
  const androidPermissions = new Map([
    [
      'geolocation',
      [
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.ACCESS_FINE_LOCATION',
      ],
    ],
    ['microphone', ['android.permission.RECORD_AUDIO']],
    ['notifications', ['android.permission.POST_NOTIFICATIONS']],
  ]);
  const unsupported = options.permissions.filter(
    (permission) => !androidPermissions.has(permission),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `No Android permission adapter for: ${unsupported.join(', ')}`,
    );
  }
  for (const permission of options.permissions.flatMap(
    (value) => androidPermissions.get(value) ?? [],
  )) {
    const result = await shell(device, `pm grant ${packageName} ${permission}`);
    if (result) {
      throw new Error(`Could not grant ${permission}: ${result}`);
    }
  }
  const launchArgs = options.launchOptions.args ?? [];
  const supportedLaunchArgs = new Set([
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ]);
  const unsupportedArgs = launchArgs.filter(
    (arg) => !supportedLaunchArgs.has(arg),
  );
  if (unsupportedArgs.length > 0) {
    throw new Error(
      `No Android launch-option adapter for: ${unsupportedArgs.join(', ')}`,
    );
  }
  let needsReload = false;
  if (launchArgs.includes('--use-fake-device-for-media-stream')) {
    await page.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (!constraints?.audio) return original(constraints);
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        return destination.stream;
      };
    });
    needsReload = true;
  }
  if (needsReload) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    // The reload wrapper proves that Angular replaced the static boot shell,
    // but Application Runtime can still be restoring while the emulator is
    // under sustained load. The package was cleared before this fixture, so
    // the login form is the finite ready surface for launch-option adapters.
    await page.getByLabel('Homeserver', { exact: true }).waitFor({
      state: 'visible',
      timeout: 60_000,
    });
  }

  // API 36 can keep returning its default GPS fix despite emulator-console updates.
  // Drive the Android GPS test provider, so Capacitor still receives native location
  // updates rather than a JavaScript geolocation stub. Keep pulsing for late listeners.
  let locationPulse: ReturnType<typeof setInterval> | undefined;
  let locationPulseTask: Promise<void> | undefined;
  if (options.geolocation) {
    await shell(
      device,
      'appops set com.android.shell android:mock_location allow',
    );
    await shell(
      device,
      'cmd location providers add-test-provider gps --requiresSatellite --supportsAltitude --supportsSpeed --supportsBearing --powerRequirement 3',
    );
    await shell(
      device,
      'cmd location providers set-test-provider-enabled gps true',
    );
    await setEmulatorLocation(device, options.geolocation);
    const pulseLocation = () => {
      if (locationPulseTask) return;
      locationPulseTask = setEmulatorLocation(device, options.geolocation!)
        .catch((error: unknown) => {
          console.warn(
            '[android-e2e] could not pulse emulator location',
            error,
          );
        })
        .finally(() => {
          locationPulseTask = undefined;
        });
    };
    locationPulse = setInterval(pulseLocation, 1_000);
  }

  return async () => {
    if (locationPulse) clearInterval(locationPulse);
    await locationPulseTask;
    if (options.geolocation) {
      await shell(device, 'cmd location providers remove-test-provider gps');
      await shell(
        device,
        'appops set com.android.shell android:mock_location default',
      );
    }
  };
}

async function attachFailureArtifacts(
  device: AndroidDevice,
  page: Page,
  testInfo: TestInfo,
  tracePaths: readonly string[],
  crashLog: string,
  initialErrors: readonly string[] = [],
): Promise<void> {
  const collectionErrors = [...initialErrors];
  const bounded = async <T,>(
    label: string,
    operation: Promise<T>,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out after 10 seconds`)),
            10_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const webviewScreenshot = testInfo.outputPath('webview.png');
  try {
    await bounded(
      'WebView screenshot',
      page.screenshot({ path: webviewScreenshot }),
    );
    await testInfo.attach('webview.png', {
      path: webviewScreenshot,
      contentType: 'image/png',
    });
  } catch (error) {
    collectionErrors.push(`WebView screenshot: ${String(error)}`);
  }

  const deviceScreenshot = testInfo.outputPath('device.png');
  try {
    await bounded(
      'device screenshot',
      device.screenshot({ path: deviceScreenshot }),
    );
    await testInfo.attach('device.png', {
      path: deviceScreenshot,
      contentType: 'image/png',
    });
  } catch (error) {
    collectionErrors.push(`Device screenshot: ${String(error)}`);
  }

  const diagnosticCommands = [
    ['logcat.txt', 'logcat -b all -d'],
    ['activity.txt', 'dumpsys activity activities'],
    ['package.txt', `dumpsys package ${packageName}`],
  ] as const;
  const diagnostics = await Promise.allSettled(
    diagnosticCommands.map(([name, command]) =>
      bounded(name, shell(device, command)),
    ),
  );
  const attachments: Promise<void>[] = [
    testInfo.attach('crash-buffer.txt', {
      body: Buffer.from(crashLog),
      contentType: 'text/plain',
    }),
    ...tracePaths.map((path, index) =>
      testInfo.attach(`trace-${index + 1}.zip`, {
        path,
        contentType: 'application/zip',
      }),
    ),
  ];
  diagnostics.forEach((result, index) => {
    const [name] = diagnosticCommands[index]!;
    if (result.status === 'fulfilled') {
      attachments.push(
        testInfo.attach(name, {
          body: Buffer.from(result.value),
          contentType: 'text/plain',
        }),
      );
    } else {
      collectionErrors.push(`${name}: ${String(result.reason)}`);
    }
  });
  if (collectionErrors.length > 0) {
    attachments.push(
      testInfo.attach('artifact-collection-errors.txt', {
        body: Buffer.from(collectionErrors.join('\n')),
        contentType: 'text/plain',
      }),
    );
  }
  await Promise.allSettled(attachments);
}

const androidTest = base.extend<AndroidFixtures, AndroidWorkerFixtures>({
  androidDevice: [
    async ({}, use) => {
      const expectedSerial = process.env['TRINITY_ANDROID_SERIAL'];
      if (!expectedSerial) {
        throw new Error(
          'TRINITY_ANDROID_SERIAL is required by the Android fixture',
        );
      }
      let devices: AndroidDevice[];
      try {
        devices = await _android.devices();
      } catch {
        throw infrastructureFailure(
          'playwright-driver',
          `Playwright could not enumerate Android devices for ${expectedSerial}`,
        );
      }
      const device = devices.find(
        (candidate) => candidate.serial() === expectedSerial,
      );
      if (!device) {
        await Promise.allSettled(devices.map((candidate) => candidate.close()));
        throw infrastructureFailure(
          'playwright-driver',
          `Playwright could not attach to ${expectedSerial}`,
        );
      }
      await Promise.allSettled(
        devices
          .filter((candidate) => candidate !== device)
          .map((candidate) => candidate.close()),
      );
      device.setDefaultTimeout(30_000);
      await use(device);

      const closed = await Promise.race([
        device.close().then(() => true),
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), 5_000),
        ),
      ]);
      if (!closed) {
        console.warn(
          '[android-e2e] Playwright device close timed out; the outer runner will remove its drivers.',
        );
      }
    },
    { scope: 'worker' },
  ],

  app: async ({ androidDevice }, use, testInfo) => {
    await shell(androidDevice, 'logcat -b all -c');
    const staleWebViews = new Set(androidDevice.webViews());
    await clearPackageData(androidDevice, packageName);

    let { page } = await launchApp(androidDevice, staleWebViews);
    await waitForApplicationReadySurface(page, 'initial Android app launch');
    await page.getByLabel('Homeserver', { exact: true }).waitFor({
      state: 'visible',
      timeout: 60_000,
    });
    let activeContext = page.context();
    let traceIndex = 0;
    const tracePaths: string[] = [];
    await activeContext.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });

    const stopTrace = async (): Promise<void> => {
      const path = testInfo.outputPath(`android-trace-${traceIndex}.zip`);
      traceIndex += 1;
      await activeContext.tracing.stop({ path });
      tracePaths.push(path);
    };

    const navigate: Navigate = navigateApplication;

    const app: AndroidApp = {
      device: androidDevice,
      get page(): Page {
        return page;
      },
      navigate,
      async inputText(text: string): Promise<void> {
        const sdkRoot =
          process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
        if (!sdkRoot) {
          throw new Error(
            'ANDROID_HOME or ANDROID_SDK_ROOT is required for Android input',
          );
        }
        await exec(
          join(sdkRoot, 'platform-tools/adb'),
          ['-s', androidDevice.serial(), 'shell', 'input', 'text', text],
          { timeout: 10_000 },
        );
      },
      async pressKey(keyCode: number): Promise<void> {
        const sdkRoot =
          process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
        if (!sdkRoot) {
          throw new Error(
            'ANDROID_HOME or ANDROID_SDK_ROOT is required for Android input',
          );
        }
        await exec(
          join(sdkRoot, 'platform-tools/adb'),
          [
            '-s',
            androidDevice.serial(),
            'shell',
            'input',
            'keyevent',
            String(keyCode),
          ],
          { timeout: 10_000 },
        );
      },
      async pressBack(): Promise<void> {
        // Playwright's instrumentation-level Android input is accepted on API 36
        // without reaching the foreground Activity. Host adb traverses Android's
        // real Back dispatcher and Capacitor AppPlugin.
        await this.pressKey(4);
      },
      async touch(control: Locator): Promise<void> {
        await touchAndroidControl(page, control);
      },
      async relaunch(): Promise<Page> {
        await stopTrace();
        const accountId = new URL(page.url()).searchParams.get('account');
        if (!accountId) {
          throw new Error(
            `Cannot verify authenticated restart without an Account-qualified route: ${page.url()}`,
          );
        }
        // Capacitor Preferences resolves after SharedPreferences.apply(), whose
        // disk write is asynchronous. Observe the on-disk Active Account before
        // force-stop so this journey proves restart restoration rather than a
        // race between Android persistence and the test's process kill.
        await waitForDurableActiveAccount(
          androidDevice,
          packageName,
          accountId,
        );
        const previousWebViews = new Set(androidDevice.webViews());
        await shell(androidDevice, `am force-stop ${packageName}`);
        ({ page } = await launchApp(androidDevice, previousWebViews));
        await waitForApplicationReadySurface(
          page,
          'authenticated Android app relaunch',
        );
        activeContext = page.context();
        await activeContext.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true,
        });
        return page;
      },
    };

    await use(app);

    let crashLog = '';
    let crashReadError: unknown;
    try {
      await stopTrace().catch(() => undefined);
      try {
        crashLog = await shell(androidDevice, 'logcat -b crash -d');
      } catch (error) {
        crashReadError = error;
      }
      const appCrashProcesses = trinityCrashProcessNames(crashLog);
      const failed =
        testInfo.status !== testInfo.expectedStatus ||
        appCrashProcesses.length > 0 ||
        Boolean(crashReadError);
      if (failed) {
        await attachFailureArtifacts(
          androidDevice,
          page,
          testInfo,
          tracePaths,
          crashLog,
          crashReadError ? [`Crash buffer: ${String(crashReadError)}`] : [],
        );
      } else {
        for (const tracePath of tracePaths) rmSync(tracePath, { force: true });
      }
    } finally {
      await shell(androidDevice, `am force-stop ${packageName}`).catch(
        () => undefined,
      );
    }
    if (crashReadError && testInfo.status === testInfo.expectedStatus) {
      throw new Error(
        `Could not inspect the Android crash buffer: ${String(crashReadError)}`,
      );
    }
    expect(
      trinityCrashProcessNames(crashLog),
      'Trinity processes must stay out of the Android crash buffer',
    ).toEqual([]);
  },

  touchPlatform: async ({ app }, use) => {
    await use({
      async tap(page, target): Promise<void> {
        if (page !== app.page) {
          throw new Error(
            'Android touch input must target the primary app WebView',
          );
        }
        await app.touch(target);
      },
      async dismissKeyboard(page): Promise<void> {
        if (page !== app.page) {
          throw new Error(
            'Android keyboard dismissal must target the primary app WebView',
          );
        }
        const keyboardShown = async () =>
          /mInputShown=true/.test(
            await shell(app.device, 'dumpsys input_method'),
          );
        if (await keyboardShown()) {
          await app.pressBack();
          await expect.poll(keyboardShown, { timeout: 10_000 }).toBe(false);
        }
      },
      async swipe(page): Promise<void> {
        if (page !== app.page) {
          throw new Error(
            'Android touch input must target the primary app WebView',
          );
        }
        throw new Error(
          'Android compositor touch panning is unavailable through the attached WebView DevTools endpoint',
        );
      },
    });
  },

  secondaryApp: async ({ androidDevice, app }, use) => {
    let secondaryPage: Page | undefined;
    try {
      await use({
        async launch(): Promise<Page> {
          if (secondaryPage) return secondaryPage;
          const staleWebViews = new Set(androidDevice.webViews());
          await clearPackageData(androidDevice, secondaryPackageName);
          const permissionResult = await shell(
            androidDevice,
            `pm grant ${secondaryPackageName} android.permission.POST_NOTIFICATIONS`,
          );
          if (permissionResult) {
            throw new Error(
              `Could not grant notifications to ${secondaryPackageName}: ${permissionResult}`,
            );
          }
          ({ page: secondaryPage } = await launchPackage(
            androidDevice,
            secondaryPackageName,
            `${secondaryPackageName}/${packageName}.MainActivity`,
            staleWebViews,
          ));
          await waitForApplicationReadySurface(
            secondaryPage,
            'secondary Android app launch',
          );
          await secondaryPage
            .getByLabel('Homeserver', { exact: true })
            .waitFor({
              state: 'visible',
              timeout: 60_000,
            });
          configureApplicationNavigation(
            secondaryPage,
            'secondary Android WebView',
          );
          return secondaryPage;
        },
        async activatePrimary(): Promise<void> {
          await shell(
            androidDevice,
            `am start -W -n ${packageName}/.MainActivity`,
          );
          await waitForActivatedApplicationPage(
            app.page,
            'primary Android app activation after secondary app',
          );
        },
      });
    } finally {
      await shell(androidDevice, `am force-stop ${secondaryPackageName}`).catch(
        () => undefined,
      );
    }
  },

  authPlatform: async ({ androidDevice, app }, use) => {
    let externalContext: BrowserContext | undefined;

    const ensureExternalContext = async (): Promise<BrowserContext> => {
      externalContext ??= await androidDevice.launchBrowser({
        ignoreHTTPSErrors: true,
        // Chrome resolves localhost to IPv6 first on the API 36 image, while adb reverse
        // exposes the host harness on IPv4 loopback. Keep the provider navigation on the
        // same deterministic path the Capacitor WebView already uses.
        args: ['--host-resolver-rules=MAP localhost 127.0.0.1'],
      });
      return externalContext;
    };

    const activatePrimary = async (): Promise<void> => {
      await shell(androidDevice, `am start -W -n ${packageName}/.MainActivity`);
      await waitForActivatedApplicationPage(
        app.page,
        'primary Android app activation',
      );
    };

    try {
      await use({
        isNative: true,
        oidcApplicationType: 'native',
        async route(appPage, matcher, handler): Promise<void> {
          await appPage.route(matcher, handler);
          const context = await ensureExternalContext();
          await context.route(matcher, handler);
          await activatePrimary();
        },
        async waitForExternalPage(appPage, trigger): Promise<Page> {
          const context = await ensureExternalContext();
          await context.clearCookies();
          await activatePrimary();
          const observedPages: Page[] = [];
          const navigationListeners = new Map<Page, (frame: Frame) => void>();
          let observingTrigger = false;
          const notePage = (candidate: Page): void => {
            if (observingTrigger && !observedPages.includes(candidate)) {
              observedPages.push(candidate);
            }
          };
          const watchPage = (candidate: Page): void => {
            if (navigationListeners.has(candidate)) return;
            const onFrameNavigated = (frame: Frame): void => {
              if (frame === candidate.mainFrame()) notePage(candidate);
            };
            candidate.on('framenavigated', onFrameNavigated);
            navigationListeners.set(candidate, onFrameNavigated);
          };
          const onPage = (candidate: Page): void => {
            notePage(candidate);
            watchPage(candidate);
          };
          context.on('page', onPage);
          const knownPages = new Map(
            context.pages().map((candidate) => [candidate, candidate.url()]),
          );
          for (const candidate of knownPages.keys()) watchPage(candidate);
          let externalPage: Page | undefined;
          try {
            observingTrigger = true;
            await trigger();
            await expect
              .poll(
                () => {
                  externalPage = findTriggeredExternalPage(
                    knownPages,
                    context.pages(),
                    observedPages,
                  );
                  return externalPage !== undefined;
                },
                {
                  message:
                    'Native authentication must create or navigate a Custom Tab',
                  timeout: 30_000,
                },
              )
              .toBe(true);
          } finally {
            observingTrigger = false;
            context.off('page', onPage);
            for (const [candidate, listener] of navigationListeners) {
              candidate.off('framenavigated', listener);
            }
          }
          if (!externalPage) {
            throw new Error(
              'Native authentication did not expose a changed Custom Tab page',
            );
          }
          if (externalPage === appPage) {
            throw new Error(
              'Native authentication stayed in Trinity instead of opening a Custom Tab',
            );
          }
          return externalPage;
        },
        async openIsolatedPage() {
          const context = await ensureExternalContext();
          await context.clearCookies();
          const page = await context.newPage();
          return {
            page,
            async close(): Promise<void> {
              await page.close().catch(() => undefined);
              await context.clearCookies().catch(() => undefined);
              await activatePrimary().catch(() => undefined);
            },
          };
        },
        callbackUrl: nativeCallbackUrl,
        async navigateCallback(appPage, callbackPath, kind): Promise<void> {
          const url = nativeCallbackUrl(appPage, callbackPath, kind);
          await shell(
            androidDevice,
            `am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d ${shellQuote(url)} -p ${packageName}`,
          );
          await waitForActivatedApplicationPage(
            appPage,
            'primary Android app authentication callback',
          );
        },
      });
    } finally {
      await shell(androidDevice, 'am force-stop com.android.chrome').catch(
        () => undefined,
      );
      if (externalContext) {
        await Promise.race([
          externalContext.close().catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
    }
  },

  context: async ({ app }, use) => {
    await use(app.page.context() as BrowserContext);
  },

  page: async (
    {
      app,
      colorScheme,
      deviceScaleFactor,
      geolocation,
      hasTouch,
      isMobile,
      launchOptions,
      permissions,
      userAgent,
      viewport,
    },
    use,
  ) => {
    const page = app.page;
    if (!page.url().startsWith(appOrigin)) {
      throw new Error(
        `Expected ${packageName}'s WebView at ${appOrigin}; attached page is ${page.url()}`,
      );
    }
    const stopAdapters = await configurePage(app.device, page, {
      colorScheme,
      deviceScaleFactor,
      geolocation,
      hasTouch,
      isMobile,
      launchOptions,
      // Push registration requests the Android 13+ notification permission after
      // login. Ordinary journeys grant it up front so an OS-owned prompt cannot
      // consume their first hardware Back press. A spec can still override this.
      permissions: permissions ?? ['notifications'],
      userAgent,
      viewport,
    });
    try {
      await use(page);
    } finally {
      await stopAdapters();
    }
  },
});

export const test = androidTest.extend(resourceFixtureDefinitions);

export { expect } from '@playwright/test';
