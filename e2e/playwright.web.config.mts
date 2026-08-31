import { defineConfig, devices } from '@playwright/test';
import { e2eEndpoint, e2eReportConfig } from './support/playwright-config.mts';

const baseURL = e2eEndpoint('application');

/** Production Web/PWA contract against the exact artifact wrapped by native hosts. */
export default defineConfig({
  testDir: './web',
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  ...e2eReportConfig('web'),
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
});
