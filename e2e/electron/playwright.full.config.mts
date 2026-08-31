import { defineConfig } from '@playwright/test';
import { ELECTRON_FULL_SUITE } from '../support/host-suites.mts';
import { e2eReportConfig } from '../support/playwright-config.mts';

/**
 * Electron E2E launches the built desktop shell through Playwright's `_electron`
 * API. The lifecycle project builds the host first and the shared invocation
 * owns Electron and disposable Synapse resources.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.electron.spec.mts',
  ...e2eReportConfig(ELECTRON_FULL_SUITE),
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
});
