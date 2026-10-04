import { join } from 'node:path';
import { e2eArtifactPath } from '../../support/playwright-config.mts';
import type { E2ESuiteDefinition } from '../../support/e2e-registry.types.mts';
import { MOBILE_ANDROID_SUITE } from '../../support/host-suites.mts';

/** wdio, Appium, screenshot and JUnit output for this invocation's run id. */
export const wdioOutputDir = (
  suite: Pick<
    E2ESuiteDefinition,
    'id' | 'targetProject'
  > = MOBILE_ANDROID_SUITE,
): string => e2eArtifactPath(suite.targetProject, suite.id, 'wdio');

/** Android's Appium log, which names the chromedriver it chose. */
export const appiumLogPath = (): string => join(wdioOutputDir(), 'appium.log');
