import { defineConfig, devices } from '@playwright/test';
import { registeredE2ESuite } from '../registry/index.mts';
import { appE2EConfig } from '../browser/support/app-e2e-config.mts';
import {
  e2eEndpoint,
  e2eLifecycleConfig,
} from '../support/playwright-config.mts';

const lifecycle = e2eLifecycleConfig({
  suite: registeredE2ESuite('site.shots'),
  projectRoot: import.meta.dirname,
  testDir: '.',
  endpoint: 'application',
  timeout: 300_000,
});
const appConfig = appE2EConfig(e2eEndpoint('application'));

/** Landing-page scenes from a production build against a seeded disposable homeserver. */
export default defineConfig({
  ...lifecycle,
  ...appConfig,
  // The seed runs once per worker, so a retry would seed every room a second time.
  retries: 0,
  use: {
    ...lifecycle.use,
    ...appConfig.use,
    locale: 'en-US',
    timezoneId: 'UTC',
    // As in the production-renderer suite: the PWA worker turns the self-signed homeserver
    // fetch into a synthetic 504.
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
