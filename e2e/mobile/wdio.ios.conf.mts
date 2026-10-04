import { join } from 'node:path';
import { MOBILE_IOS_SUITE } from '../support/host-suites.mts';
import { APP_PACKAGE } from './support/session.mts';
import { mobileWdioConfig, workspaceRoot } from './wdio.base.mts';

const iosCapabilities = {
  platformName: 'iOS',
  'appium:automationName': 'XCUITest',
  'appium:udid': process.env['TRINITY_IOS_UDID'],
  'appium:bundleId': APP_PACKAGE,
  'appium:noReset': true,
  'appium:newCommandTimeout': 240,
  // The first session builds WebDriverAgent (~7 min on the hosted runner); CI caches this.
  'appium:derivedDataPath': join(workspaceRoot, 'dist/ios-wda/DerivedData'),
  'appium:wdaLaunchTimeout': 600_000,
  'appium:wdaConnectionTimeout': 600_000,
  'appium:showXcodeLog': true,
  // Web Inspector lists the Capacitor app by process name (process-App), not bundle id.
  'appium:additionalWebviewBundleIds': ['process-App'],
  'appium:webviewConnectTimeout': 60_000,
  'appium:includeSafariInWebviews': false,
  // The notification prompt appears at first launch, and simctl privacy cannot grant it.
  'appium:autoAcceptAlerts': true,
  // Typing and keyboardShown() need the on-screen keyboard, not the host's.
  'appium:connectHardwareKeyboard': false,
  'appium:forceSimulatorSoftwareKeyboardPresence': true,
};

export const config = mobileWdioConfig({
  suite: MOBILE_IOS_SUITE,
  capabilities: iosCapabilities as WebdriverIO.Capabilities,
  // Session creation waits for the WebDriverAgent build.
  connectionRetryTimeout: 900_000,
});
