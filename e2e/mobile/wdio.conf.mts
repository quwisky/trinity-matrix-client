import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  suiteSummaryPath,
  wdioSuiteSummary,
  type WdioLauncherResult,
} from '../support/execution-report.mts';
import { MOBILE_ANDROID_SUITE } from '../support/host-suites.mts';
import { readSession } from '../support/session.mts';

const workspaceRoot = join(import.meta.dirname, '../..');
const startedAt = Date.now();
const outputDir = join(
  workspaceRoot,
  'dist/.wdio/trinity-e2e-mobile',
  process.env['TRINITY_E2E_RUN_ID'] ?? 'local',
);

export const config: WebdriverIO.Config = {
  runner: 'local',
  // Appium drives the emulator; no display is needed, and wdio's xvfb-run wrapper breaks the worker IPC channel.
  autoXvfb: false,
  specs: ['./specs/**/*.e2e.mts'],
  maxInstances: 1,
  logLevel: 'warn',
  outputDir,
  capabilities: [
    {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:udid': process.env['TRINITY_ANDROID_SERIAL'],
      'appium:appPackage': 'eu.qwky.trinity',
      'appium:appActivity': '.MainActivity',
      'appium:noReset': true,
      'appium:autoGrantPermissions': true,
      'appium:newCommandTimeout': 240,
      'appium:chromedriverExecutableDir': join(
        workspaceRoot,
        '.appium/chromedriver',
      ),
      'appium:ensureWebviewsHavePages': true,
      'appium:nativeWebScreenshot': true,
      acceptInsecureCerts: true,
    },
  ],
  services: [
    [
      'appium',
      {
        command: join(workspaceRoot, 'node_modules/.bin/appium'),
        args: {
          allowInsecure: '*:chromedriver_autodownload,*:adb_shell',
          log: join(outputDir, 'appium.log'),
        },
      },
    ],
  ],
  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 180_000, retries: 0 },
  specFileRetries: 0,
  reporters: ['spec', ['junit', { outputDir: join(outputDir, 'junit') }]],
  waitforTimeout: 20_000,
  async afterTest(test, _context, { passed }) {
    if (passed) return;
    const name = test.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    await browser
      .saveScreenshot(join(outputDir, `${name}.png`))
      .catch(() => undefined);
    await browser.switchContext('NATIVE_APP').catch(() => undefined);
    const hierarchy = await browser.getPageSource().catch(() => '');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, `${name}.native.xml`), hierarchy);
  },
  /** Publish the suite summary the E2E aggregate runner validates. */
  onComplete(
    exitCode: number,
    _config,
    _capabilities,
    result: WdioLauncherResult,
  ) {
    const session = readSession();
    const file = suiteSummaryPath(
      session.workspaceRoot,
      MOBILE_ANDROID_SUITE.targetProject,
      session.id,
      MOBILE_ANDROID_SUITE.id,
    );
    const summary = wdioSuiteSummary({
      suiteId: MOBILE_ANDROID_SUITE.id,
      exitCode,
      durationMs: Date.now() - startedAt,
      result,
    });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(summary, undefined, 2)}\n`);
  },
};
