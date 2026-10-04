import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
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

/**
 * Copy the native homeserver's two log files (when they exist) into a diagnostics
 * directory; stop.mjs deletes ./data at teardown. Never copy anything else from ./data:
 * caddy-data holds the CA private key.
 */
export function copyHomeserverLogs(
  logs: Readonly<Record<string, string>>,
  destination: string,
): void {
  mkdirSync(destination, { recursive: true });
  for (const file of Object.values(logs)) {
    if (existsSync(file)) copyFileSync(file, join(destination, basename(file)));
  }
}
