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
    'appium:nativeWebScreenshot': true,
    acceptInsecureCerts: true,
  },
  appiumArgs: { allowInsecure: '*:chromedriver_autodownload,*:adb_shell' },
});
