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
    // Otherwise Appium keeps one chromedriver per context and restarts it in place after
    // each app relaunch; if that restart fails ("chrome not reachable" after 60 s), the
    // cached chromedriver stays offline and every later switch in the session fails with
    // "Can't restart when we're not online". Leaving the WebView now stops chromedriver, so
    // each switch starts one for the running app and wdio's request retry starts afresh.
    'appium:recreateChromeDriverSessions': true,
    'appium:nativeWebScreenshot': true,
    acceptInsecureCerts: true,
  },
  appiumArgs: { allowInsecure: '*:chromedriver_autodownload,*:adb_shell' },
});
