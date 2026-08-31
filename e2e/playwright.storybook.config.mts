import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { e2eEndpoint, e2eReportConfig } from './support/playwright-config.mts';

const baseURL = e2eEndpoint('storybook');

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
  ...e2eReportConfig('storybook'),
  use: {
    baseURL,
    trace: 'retain-on-failure',
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
