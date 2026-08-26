import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

const baseURL = 'http://localhost:4401';

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
  outputDir: '../dist/.playwright/styling/test-output',
  reporter: [
    [
      'html',
      {
        outputFolder: '../dist/.playwright/styling/playwright-report',
        open: 'never',
      },
    ],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'pnpm exec nx run trinity:build:development && PORT=4401 node e2e/playwright/support/serve-www.mjs',
    url: baseURL,
    // A stale app server can otherwise hide the exact stylesheet change under test.
    reuseExistingServer: false,
    timeout: 240_000,
    cwd: workspaceRoot,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
