import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { appE2EConfig } from './playwright/support/app-e2e-config.mts';

const baseURL = 'http://localhost:4200';

/** Focused cross-browser rendering contract for native scrollbar implementations. */
export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './playwright' }),
  ...appE2EConfig(baseURL, { reuseExistingServer: false }),
  testMatch: ['settings-scrollbars.spec.mts', 'message-markdown.spec.mts'],
  grep: /Settings scrollbars|syntax-highlights a fenced block/,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
