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
  page: Page;
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
): Promise<void> {
  const screenshotErrors: string[] = [];
  const webviewScreenshot = testInfo.outputPath('webview.png');
  try {
    await page.screenshot({ path: webviewScreenshot });
    await testInfo.attach('webview.png', {
      path: webviewScreenshot,
      contentType: 'image/png',
    });
  } catch (error) {
    screenshotErrors.push(`WebView: ${String(error)}`);
  }

  const deviceScreenshot = testInfo.outputPath('device.png');
  try {
    await device.screenshot({ path: deviceScreenshot });
    await testInfo.attach('device.png', {
      path: deviceScreenshot,
      contentType: 'image/png',
    });
  } catch (error) {
    screenshotErrors.push(`Device: ${String(error)}`);
  }

  const diagnostics = [
    await shell(device, 'logcat -b all -d'),
    await shell(device, `dumpsys activity activities`),
    await shell(device, `dumpsys package ${packageName}`),
  ];
  await Promise.all([
    testInfo.attach('logcat.txt', {
      body: Buffer.from(diagnostics[0]),
      contentType: 'text/plain',
    }),
    testInfo.attach('activity.txt', {
      body: Buffer.from(diagnostics[1]),
      contentType: 'text/plain',
    }),
    testInfo.attach('package.txt', {
      body: Buffer.from(diagnostics[2]),
      contentType: 'text/plain',
    }),
    testInfo.attach('crash-buffer.txt', {
      body: Buffer.from(crashLog),
      contentType: 'text/plain',
    }),
    ...(screenshotErrors.length > 0
      ? [
          testInfo.attach('screenshot-errors.txt', {
            body: Buffer.from(screenshotErrors.join('\n')),
            contentType: 'text/plain',
          }),
        ]
      : []),
    ...tracePaths.map((path, index) =>
      testInfo.attach(`trace-${index + 1}.zip`, {
        path,
        contentType: 'application/zip',
      }),
    ),
  ]);
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
    await shell(androidDevice, `pm clear ${packageName}`);

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
      page,
      navigate,
      async touch(control: Locator): Promise<void> {
        const box = await control.boundingBox();
        if (!box) throw new Error('Cannot touch an element without a bounding box');
        const session = await page.context().newCDPSession(page);
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [point],
        });
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
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

    await stopTrace().catch(() => undefined);
    const crashLog = await shell(androidDevice, 'logcat -b crash -d');
    const failed = testInfo.status !== testInfo.expectedStatus || crashLog.length > 0;
    if (failed) {
      await attachFailureArtifacts(androidDevice, page, testInfo, tracePaths, crashLog);
    } else {
      for (const tracePath of tracePaths) rmSync(tracePath, { force: true });
    }
    await shell(androidDevice, `am force-stop ${packageName}`);
    expect(crashLog, 'Android crash log must stay empty').toBe('');
  },
});

export { expect } from '@playwright/test';
