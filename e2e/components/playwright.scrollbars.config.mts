import { defineConfig, devices } from '@playwright/test';
import { registeredE2ESuite } from '../registry/index.mts';
import { appE2EConfig } from '../playwright/support/app-e2e-config.mts';
import {
  e2eEndpoint,
  e2eLifecycleConfig,
} from '../support/playwright-config.mts';

const lifecycle = e2eLifecycleConfig({
  suite: registeredE2ESuite('components.scrollbars'),
  projectRoot: import.meta.dirname,
  testDir: '../playwright',
  endpoint: 'application',
  timeout: 120_000,
});
const app = appE2EConfig(e2eEndpoint('application'));

/** Focused cross-browser rendering contract for native scrollbar implementations. */
export default defineConfig({
  ...lifecycle,
  ...app,
  use: { ...lifecycle.use, ...app.use },
  testMatch: ['settings-scrollbars.spec.mts', 'message-markdown.spec.mts'],
  grep: /Settings scrollbars|syntax-highlights a fenced block/,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
