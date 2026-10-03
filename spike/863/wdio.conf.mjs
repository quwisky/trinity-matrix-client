// Throwaway spike for #863: one Appium XCUITest session against the simulator build.
import { join } from 'node:path';

const out = process.env.SPIKE_OUT;
export const config = {
  runner: 'local',
  specs: [join(import.meta.dirname, 'probe.e2e.mjs')],
  maxInstances: 1,
  logLevel: 'info',
  outputDir: out,
  hostname: '127.0.0.1',
  port: 4723,
  capabilities: [
    {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:udid': process.env.SPIKE_UDID,
      'appium:bundleId': 'eu.qwky.trinity',
      'appium:noReset': true,
      'appium:newCommandTimeout': 300,
      'appium:wdaLaunchTimeout': 600_000,
      'appium:wdaConnectionTimeout': 600_000,
      'appium:showXcodeLog': true,
      'appium:webviewConnectTimeout': 60_000,
      'appium:includeSafariInWebviews': false,
      // Web Inspector lists the Capacitor app by process name, not bundle id.
      'appium:additionalWebviewBundleIds': ['process-App'],
    },
  ],
  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 900_000 },
  reporters: ['spec'],
};
