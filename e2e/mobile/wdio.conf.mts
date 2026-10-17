import { join } from 'node:path';
import { MOBILE_ANDROID_SUITE } from '../support/host-suites.mts';
import { mobileWdioConfig, workspaceRoot } from './wdio.base.mts';

export const config = mobileWdioConfig({
  suite: MOBILE_ANDROID_SUITE,
  capabilities: {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:udid': process.env['TRINITY_ANDROID_SERIAL'],
    'appium:appPackage': 'dev.trinityproject.trinity',
    'appium:appActivity': '.MainActivity',
    'appium:noReset': true,
    'appium:autoGrantPermissions': true,
    'appium:newCommandTimeout': 240,
    'appium:chromedriverExecutableDir': join(
      workspaceRoot,
      '.appium/chromedriver',
    ),
    'appium:ensureWebviewsHavePages': true,
    // A chromedriver that fails to attach after an app relaunch ("chrome not reachable" at
    // 60 s) must not stay cached: stop it on leaving the WebView, so connectionRetryCount's
    // retry of the switch starts a fresh one for the running app.
    'appium:recreateChromeDriverSessions': true,
    'appium:nativeWebScreenshot': true,
    acceptInsecureCerts: true,
  },
  appiumArgs: { allowInsecure: '*:chromedriver_autodownload,*:adb_shell' },
  connectionRetryCount: 3,
});
