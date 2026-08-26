import { rmSync } from 'node:fs';
import {
  expect,
  test as base,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { _android, type AndroidDevice } from 'playwright';
import type { Navigate } from '../playwright/support/app.mts';

const packageName = 'eu.qwky.trinity';
const appOrigin = 'https://localhost';

async function shell(device: AndroidDevice, command: string): Promise<string> {
  return (await device.shell(command)).toString('utf8').trim();
}

async function enableSelfSignedTls(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send('Security.setIgnoreCertificateErrors', { ignore: true });
}

async function launchApp(
  device: AndroidDevice,
  previousPid?: number,
): Promise<{ page: Page; pid: number }> {
  await shell(device, `am start -W -n ${packageName}/.MainActivity`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const webView = device
      .webViews()
      .find((candidate) => candidate.pkg() === packageName && candidate.pid() !== previousPid);
    if (webView) {
      const page = await webView.page();
      await enableSelfSignedTls(page);
      await page.waitForLoadState('domcontentloaded');
      return { page, pid: webView.pid() };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No ${packageName} WebView appeared after launch`);
}

interface AndroidApp {
  device: AndroidDevice;
  readonly page: Page;
  navigate: Navigate;
  touch(control: Locator): Promise<void>;
  relaunch(): Promise<Page>;
}

interface AndroidFixtures {
  app: AndroidApp;
}

interface AndroidWorkerFixtures {
  androidDevice: AndroidDevice;
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
  const bounded = async <T,>(label: string, operation: Promise<T>): Promise<T> => {
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
    await bounded('WebView screenshot', page.screenshot({ path: webviewScreenshot }));
    await testInfo.attach('webview.png', {
      path: webviewScreenshot,
      contentType: 'image/png',
    });
  } catch (error) {
    collectionErrors.push(`WebView screenshot: ${String(error)}`);
  }

  const deviceScreenshot = testInfo.outputPath('device.png');
  try {
    await bounded('device screenshot', device.screenshot({ path: deviceScreenshot }));
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

export const test = base.extend<AndroidFixtures, AndroidWorkerFixtures>({
  androidDevice: [
    async ({}, use) => {
      const expectedSerial = process.env['TRINITY_ANDROID_SERIAL'];
      if (!expectedSerial) {
        throw new Error('TRINITY_ANDROID_SERIAL is required by the Android fixture');
      }
      const devices = await _android.devices();
      const device = devices.find((candidate) => candidate.serial() === expectedSerial);
      if (!device) {
        await Promise.allSettled(devices.map((candidate) => candidate.close()));
        throw new Error(`Playwright could not attach to ${expectedSerial}`);
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
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
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
    await shell(androidDevice, `am force-stop ${packageName}`);
    const clearResult = await shell(androidDevice, `pm clear ${packageName}`);
    if (clearResult !== 'Success') {
      throw new Error(`pm clear ${packageName} failed: ${clearResult || '<empty output>'}`);
    }

    let { page, pid } = await launchApp(androidDevice);
    let activeContext = page.context();
    let traceIndex = 0;
    const tracePaths: string[] = [];
    await activeContext.tracing.start({ screenshots: true, snapshots: true, sources: true });

    const stopTrace = async (): Promise<void> => {
      const path = testInfo.outputPath(`android-trace-${traceIndex}.zip`);
      traceIndex += 1;
      await activeContext.tracing.stop({ path });
      tracePaths.push(path);
    };

    const navigate: Navigate = async (targetPage, path) => {
      await targetPage.goto(new URL(path, appOrigin).href, {
        waitUntil: 'networkidle',
      });
    };

    const app: AndroidApp = {
      device: androidDevice,
      get page(): Page {
        return page;
      },
      navigate,
      async touch(control: Locator): Promise<void> {
        const box = await control.boundingBox();
        if (!box) throw new Error('Cannot touch an element without a bounding box');
        const webView = await androidDevice.info({
          clazz: /android\.webkit\.WebView/,
          pkg: packageName,
        });
        const viewport = await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        }));
        await androidDevice.input.tap({
          x: Math.round(
            webView.bounds.x +
              ((box.x + box.width / 2) / viewport.width) * webView.bounds.width,
          ),
          y: Math.round(
            webView.bounds.y +
              ((box.y + box.height / 2) / viewport.height) * webView.bounds.height,
          ),
        });
      },
      async relaunch(): Promise<Page> {
        await stopTrace();
        await shell(androidDevice, `am force-stop ${packageName}`);
        ({ page, pid } = await launchApp(androidDevice, pid));
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
      const failed =
        testInfo.status !== testInfo.expectedStatus ||
        crashLog.length > 0 ||
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
      await shell(androidDevice, `am force-stop ${packageName}`).catch(() => undefined);
    }
    if (crashReadError && testInfo.status === testInfo.expectedStatus) {
      throw new Error(`Could not inspect the Android crash buffer: ${String(crashReadError)}`);
    }
    expect(crashLog, 'Android crash log must stay empty').toBe('');
  },
});

export { expect } from '@playwright/test';
