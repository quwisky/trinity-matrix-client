import { defineConfig } from '@playwright/test';
import { registeredE2ESuite } from './registry/index.mts';
import { e2eReportConfig } from './support/playwright-config.mts';

/**
 * Electron e2e — launches the BUILT desktop app (electron/dist/main.js serving www/
 * over the trinity://app scheme) via Playwright's `_electron` API. Unlike the web
 * config there's no `webServer`/`baseURL`; each spec launches the Electron process
 * itself (see e2e/electron/support/launch.mts).
 *
 * Prerequisites (run `pnpm electron:e2e`):
 *   1. `pnpm electron:install` — once, to download the Electron binary (the normal
 *      install skips it). 2. the app is built + synced (the script runs electron:build).
 *   3. a display: on a desktop session it just works; on headless Linux/CI wrap with
 *      `xvfb-run -a` (Electron needs an X server).
 */
export default defineConfig({
  // Electron specs live alongside this config in the `trinity-e2e` project.
  testDir: './electron',
  testMatch: '**/*.electron.spec.mts',
  ...e2eReportConfig(registeredE2ESuite('electron.full')),
  // Each test launches its own Electron instance — keep them serial.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
});
