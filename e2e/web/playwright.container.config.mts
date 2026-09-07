import { defineConfig, devices } from '@playwright/test';
import { registeredE2ESuite } from '../registry/index.mts';
import { e2eLifecycleConfig } from '../support/playwright-config.mts';

const lifecycle = e2eLifecycleConfig({
  suite: registeredE2ESuite('web.container'),
  projectRoot: import.meta.dirname,
  testDir: '.',
  endpoint: 'application',
  timeout: 90_000,
  expectTimeout: 30_000,
});

/** Browser-only PWA smoke against a host-owned, already-built Web container. */
export default defineConfig({
  ...lifecycle,
  testMatch: 'production-pwa.spec.mts',
  use: {
    ...lifecycle.use,
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium' }],
});
