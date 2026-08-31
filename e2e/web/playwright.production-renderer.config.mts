import { defineConfig, devices } from '@playwright/test';
import { registeredE2ESuite } from '../registry/index.mts';
import { appE2EConfig } from '../playwright/support/app-e2e-config.mts';
import { DESIGN_VIEWPORTS } from '../playwright/support/design-viewports.mts';
import {
  e2eEndpoint,
  e2eLifecycleConfig,
} from '../support/playwright-config.mts';

const lifecycle = e2eLifecycleConfig({
  suite: registeredE2ESuite('web.production-renderer'),
  projectRoot: import.meta.dirname,
  testDir: './production-renderer',
  endpoint: 'application',
  timeout: 180_000,
});
const appConfig = appE2EConfig(e2eEndpoint('application'));
const { defaultBrowserType: _safariBrowser, ...desktopSafari } =
  devices['Desktop Safari'];

/**
 * Real production-renderer semantic and responsive coverage.
 *
 * Seven projects cover a representative cross-cutting appearance, density, viewport and browser
 * matrix without storing pixel baselines in the repository.
 */
export default defineConfig({
  ...lifecycle,
  ...appConfig,
  use: {
    ...lifecycle.use,
    ...appConfig.use,
    locale: 'en-US',
    // The PWA worker turns Chromium's local self-signed Synapse fetch into a synthetic 504.
    // This suite owns renderer/layout evidence; service-worker behavior has separate tests.
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
        browserName: 'webkit',
        viewport: { width: 900, height: 700 },
      },
    },
  ],
});
