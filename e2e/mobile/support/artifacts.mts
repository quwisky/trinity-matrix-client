import { join } from 'node:path';
import { e2eArtifactPath } from '../../support/playwright-config.mts';
import { MOBILE_ANDROID_SUITE } from '../../support/host-suites.mts';

/** wdio, Appium, screenshot and JUnit output for this invocation's run id. */
export const wdioOutputDir = (): string =>
  e2eArtifactPath(
    MOBILE_ANDROID_SUITE.targetProject,
    MOBILE_ANDROID_SUITE.id,
    'wdio',
  );

export const appiumLogPath = (): string => join(wdioOutputDir(), 'appium.log');
