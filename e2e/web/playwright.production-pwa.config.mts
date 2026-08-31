import { defineConfig, devices } from '@playwright/test';
import { registeredE2ESuite } from '../registry/index.mts';
import { e2eLifecycleConfig } from '../support/playwright-config.mts';

const lifecycle = e2eLifecycleConfig({
  suite: registeredE2ESuite('web.production-pwa'),
  projectRoot: import.meta.dirname,
  testDir: '.',
  endpoint: 'application',
  timeout: 90_000,
  expectTimeout: 30_000,
});

/** Production Web/PWA contract against the exact artifact wrapped by native hosts. */
export default defineConfig({
  ...lifecycle,
  use: {
    ...lifecycle.use,
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium' }],
});
