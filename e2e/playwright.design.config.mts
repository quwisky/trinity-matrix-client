import { defineConfig } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';
import { DESIGN_VIEWPORTS } from './playwright/support/design-viewports.mts';

const baseURL = 'http://localhost:4402';

/**
 * Deterministic, Linux-authoritative captures for non-shipping redesign candidates.
 *
 * The prototype server mounts static design scenes beside the built application stylesheet.
 * No Angular route or production bundle contains these scenes.
 */
export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './design-prototypes' }),
  retries: 0,
  workers: 1,
  timeout: 30_000,
  outputDir: '../dist/.playwright/design-prototypes/test-output',
  reporter: [
    [
      'html',
      {
        outputFolder: '../dist/.playwright/design-prototypes/playwright-report',
        open: 'never',
      },
    ],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'pnpm exec nx run trinity:build:development && PORT=4402 node e2e/design-prototypes/serve.mjs',
    url: `${baseURL}/__design__/index.html`,
    reuseExistingServer: false,
    timeout: 240_000,
    cwd: workspaceRoot,
  },
  projects: Object.entries(DESIGN_VIEWPORTS).map(([name, use]) => ({
    name,
    use,
  })),
});
