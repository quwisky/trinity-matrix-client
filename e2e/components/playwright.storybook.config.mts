import { defineConfig, devices } from '@playwright/test';
import { registeredE2ESuite } from '../registry/index.mts';
import { e2eLifecycleConfig } from '../support/playwright-config.mts';

const lifecycle = e2eLifecycleConfig({
  suite: registeredE2ESuite('components.storybook'),
  projectRoot: import.meta.dirname,
  testDir: './storybook',
  endpoint: 'storybook',
  timeout: 30_000,
});

/**
 * Browser checks for the built Storybook, deliberately separate from the app journeys.
 *
 * Storybook needs neither the application dev build nor disposable Synapse. Keeping its
 * server and output here means the small component-canvas check can run without changing
 * the cost or lifecycle of the canonical application journeys.
 */
export default defineConfig({
  ...lifecycle,
  tsconfig: './tsconfig.json',
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
      testMatch: ['**/*.webkit.spec.mts', '**/tooltip-input.spec.mts'],
    },
  ],
});
