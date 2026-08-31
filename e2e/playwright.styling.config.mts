import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { e2eEndpoint, e2eReportConfig } from './support/playwright-config.mts';

const baseURL = e2eEndpoint('application');

/**
 * Browser-level CSS capability checks, deliberately separate from the Matrix journeys.
 *
 * These tests need the built application stylesheet but no Synapse homeserver. Keeping their
 * server and output isolated prevents the app E2E global setup from turning a small styling
 * regression into a Docker-backed test.
 */
export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './styling' }),
  retries: 0,
  workers: 1,
  timeout: 30_000,
  ...e2eReportConfig('styling'),
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
