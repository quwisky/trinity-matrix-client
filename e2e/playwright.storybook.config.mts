import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

const baseURL = 'http://localhost:4400';

/**
 * Browser checks for the built Storybook, deliberately separate from the app journeys.
 *
 * Storybook needs neither the application dev build nor the disposable Synapse owned by
 * `playwright.config.mts`. Keeping its server and output here means the small component-canvas
 * check can run without changing the cost or lifecycle of `trinity-e2e:e2e`.
 */
export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './storybook' }),
  retries: 0,
  workers: 1,
  timeout: 30_000,
  outputDir: '../dist/.playwright/storybook/test-output',
  reporter: [
    [
      'html',
      {
        outputFolder: '../dist/.playwright/storybook/playwright-report',
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
      'pnpm exec nx static-storybook components-storybook-host --port=4400 --watch=false',
    url: `${baseURL}/iframe.html`,
    // A stale static server can otherwise hide a freshly changed preview stylesheet locally.
    // Determinism matters more than sharing this small, dedicated server.
    reuseExistingServer: false,
    timeout: 120_000,
    cwd: workspaceRoot,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/*.mobile.spec.mts', '**/*.webkit.spec.mts'],
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 5'] },
      testMatch: '**/*.mobile.spec.mts',
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testMatch: '**/*.webkit.spec.mts',
    },
  ],
});
