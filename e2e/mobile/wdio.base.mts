import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  suiteSummaryPath,
  wdioSuiteSummary,
  type WdioLauncherResult,
} from '../support/execution-report.mts';
import type { E2ESuiteDefinition } from '../support/e2e-registry.types.mts';
import { readSession } from '../support/session.mts';
import { wdioOutputDir } from './support/artifacts.mts';
import { native } from './support/session.mts';

export const workspaceRoot = join(import.meta.dirname, '../..');

/** TRINITY_MOBILE_SPECS (comma-separated, relative to e2e/mobile) narrows a run. */
function selectedSpecs(): string[] {
  const only = (process.env['TRINITY_MOBILE_SPECS'] ?? '')
    .split(',')
    .map((spec) => spec.trim())
    .filter(Boolean);
  return only.length > 0 ? only : ['./specs/**/*.e2e.mts'];
}

/** Everything both platforms share; each platform config supplies its capabilities. */
export function mobileWdioConfig(options: {
  readonly suite: Pick<E2ESuiteDefinition, 'id' | 'targetProject'>;
  readonly capabilities: WebdriverIO.Capabilities;
  readonly appiumArgs?: Record<string, string>;
  readonly connectionRetryTimeout?: number;
}): WebdriverIO.Config {
  const { suite } = options;
  const startedAt = Date.now();
  const outputDir = wdioOutputDir(suite);
  return {
    runner: 'local',
    // Appium drives the device; no display is needed, and wdio's xvfb-run wrapper breaks the worker IPC channel.
    autoXvfb: false,
    specs: selectedSpecs(),
    maxInstances: 1,
    logLevel: 'warn',
    outputDir,
    ...(options.connectionRetryTimeout
      ? { connectionRetryTimeout: options.connectionRetryTimeout }
      : {}),
    capabilities: [options.capabilities],
    services: [
      [
        'appium',
        {
          command: join(workspaceRoot, 'node_modules/.bin/appium'),
          args: { ...options.appiumArgs, log: join(outputDir, 'appium.log') },
        },
      ],
    ],
    framework: 'mocha',
    mochaOpts: { ui: 'bdd', timeout: 180_000, retries: 0 },
    specFileRetries: 0,
    reporters: [
      'spec',
      [
        'junit',
        {
          outputDir: join(outputDir, 'junit'),
          // The default name ends in .log; CI diagnostics require an .xml report.
          outputFileFormat: ({ cid }) => `results-${cid}.xml`,
        },
      ],
    ],
    waitforTimeout: 20_000,
    async afterTest(test, _context, { passed }) {
      if (passed) return;
      const name = test.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      mkdirSync(outputDir, { recursive: true });
      await browser
        .saveScreenshot(join(outputDir, `${name}.png`))
        .catch(() => undefined);
      await native().catch(() => undefined);
      const hierarchy = await browser.getPageSource().catch(() => '');
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
        suite.targetProject,
        session.id,
        suite.id,
      );
      const summary = wdioSuiteSummary({
        suiteId: suite.id,
        exitCode,
        durationMs: Date.now() - startedAt,
        result,
      });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(summary, undefined, 2)}\n`);
    },
  };
}
