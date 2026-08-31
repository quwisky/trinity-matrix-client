import { defineConfig, devices } from '@playwright/test';
import { registeredE2ESuite } from '../registry/index.mts';
import { e2eLifecycleConfig } from '../support/playwright-config.mts';

const lifecycle = e2eLifecycleConfig({
  suite: registeredE2ESuite('components.styling'),
  projectRoot: import.meta.dirname,
  testDir: './styling',
  endpoint: 'application',
  timeout: 30_000,
});

/**
 * Browser-level CSS capability checks, deliberately separate from the Matrix journeys.
 *
 * These tests need the built application stylesheet but no Synapse homeserver. Keeping their
 * server and output isolated prevents the app E2E global setup from turning a small styling
 * regression into a Docker-backed test.
 */
export default defineConfig({
  ...lifecycle,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
