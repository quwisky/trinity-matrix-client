import { defineConfig } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { DESIGN_VIEWPORTS } from './playwright/support/design-viewports.mts';
import { appE2EConfig } from './playwright/support/app-e2e-config.mts';

const baseURL = process.env['BASE_URL'] || 'http://localhost:4200';
const projectNames = [
  'desktop-wide',
  'desktop-compact',
  'phone-pixel-5',
] as const;

/**
 * Real-application Phase 0 evidence. PNGs written by this run are ephemeral until the separate
 * promotion script atomically archives a complete, green Linux set.
 */
export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './design-baselines' }),
  ...appE2EConfig(baseURL),
  retries: 0,
  workers: 1,
  timeout: 180_000,
  outputDir: '../dist/.playwright/current-baselines/test-output',
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: '../dist/.playwright/current-baselines/playwright-report',
        open: 'never',
      },
    ],
  ],
  use: {
    ...appE2EConfig(baseURL).use,
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: projectNames.map((name) => ({
    name,
    use: DESIGN_VIEWPORTS[name],
  })),
});
