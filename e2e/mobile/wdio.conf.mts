import { join } from 'node:path';

const workspaceRoot = join(import.meta.dirname, '../..');
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
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, `${name}.native.xml`), hierarchy);
  },
};
