import { defineConfig } from '@playwright/test';
import { e2eLifecycleConfig } from '../support/playwright-config.mts';
import {
  PROTOCOL_SUITE_ENV,
  protocolCase,
  protocolMode,
  protocolScreenshotPolicy,
  protocolSuite,
  protocolTimeout,
  protocolTracePolicy,
  selectedProtocolSuiteId,
} from './runtime.mts';

// Nx imports every Playwright config while building the project graph. Use a
// harmless discovery default there; the protocol runner always sets the
// explicit suite before Playwright collects a test.
const suiteId = process.env[PROTOCOL_SUITE_ENV]
  ? selectedProtocolSuiteId()
  : 'protocol.verify-sas';
const suite = protocolSuite(suiteId);
const definition = protocolCase(suiteId);

export default defineConfig({
  ...e2eLifecycleConfig({
    suite,
    projectRoot: import.meta.dirname,
    testDir: '.',
    endpoint: 'application',
    timeout: protocolTimeout(suiteId),
    expectTimeout: 30_000,
  }),
  forbidOnly: true,
  fullyParallel: false,
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  projects: [
    {
      name: suiteId,
      testMatch: definition.spec,
      use: {
        browserName: definition.browserName,
        headless: process.env['HEADED'] !== '1',
        ignoreHTTPSErrors: protocolMode() === 'disposable',
        launchOptions: {
          slowMo: Number(process.env['SLOWMO'] ?? 0),
          ...(definition.browserName === 'chromium'
            ? { args: ['--disable-dev-shm-usage'] }
            : {}),
        },
        // Recovery setup can display a one-time key. Remote diagnostics must
        // never persist authenticated screens, even on failure.
        screenshot: protocolScreenshotPolicy(protocolMode()),
        // Remote traces can capture authenticated Matrix requests. Keep full
        // diagnostics for disposable accounts, but never persist remote tokens.
        trace: protocolTracePolicy(protocolMode(), Boolean(process.env['CI'])),
      },
    },
  ],
});
