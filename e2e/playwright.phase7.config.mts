import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { appE2EConfig } from './playwright/support/app-e2e-config.mts';
import { DESIGN_VIEWPORTS } from './playwright/support/design-viewports.mts';

const baseURL = 'http://localhost:4200';
const appConfig = appE2EConfig(baseURL, { reuseExistingServer: false });
const { defaultBrowserType: _safariBrowser, ...desktopSafari } =
  devices['Desktop Safari'];

/**
 * Real shipped-interface evidence for Phase 7.
 *
 * This is deliberately separate from the immutable Phase 0 archive and from the static design
 * prototypes. Seven projects cover the pairwise responsive/theme/density/browser matrix, while
 * the spec pixel-gates only nine stable representative surfaces.
 */
export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './phase7' }),
  ...appConfig,
  retries: 0,
  workers: 1,
  timeout: 180_000,
  outputDir: '../dist/.playwright/phase7/test-output',
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: '../dist/.playwright/phase7/playwright-report',
        open: 'never',
      },
    ],
  ],
  use: {
    ...appConfig.use,
    locale: 'en-US',
    // The PWA worker turns Chromium's local self-signed Synapse fetch into a synthetic 504.
    // This suite owns shipped UI/layout evidence; service-worker behavior has separate tests.
    serviceWorkers: 'block',
    timezoneId: 'UTC',
  },
  projects: [
    { name: 'wide-dark-cosy', use: DESIGN_VIEWPORTS['desktop-wide'] },
    {
      name: 'standard-amethyst-cosy',
      use: DESIGN_VIEWPORTS['desktop-standard'],
    },
    {
      name: 'tablet-light-compact',
      use: DESIGN_VIEWPORTS['desktop-tablet'],
    },
    {
      name: 'compact-light-large',
      use: DESIGN_VIEWPORTS['desktop-compact'],
    },
    { name: 'pixel-onyx-cosy', use: DESIGN_VIEWPORTS['phone-pixel-5'] },
    { name: 'small-light-large', use: DESIGN_VIEWPORTS['phone-small'] },
    {
      name: 'webkit-compact-light',
      use: {
        ...desktopSafari,
        viewport: { width: 900, height: 700 },
      },
    },
  ],
});
