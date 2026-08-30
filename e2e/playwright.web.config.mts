import { defineConfig, devices } from '@playwright/test';
import { workspaceRoot } from '@nx/devkit';

const baseURL = 'http://localhost:4402';

/** Production Web/PWA contract against the exact artifact wrapped by native hosts. */
export default defineConfig({
  testDir: './web',
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  outputDir: '../dist/.playwright/web/test-output',
  reporter: process.env['CI'] ? 'dot' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'pnpm exec nx run trinity:build:production && PORT=4402 node e2e/playwright/support/serve-www.mjs',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
    cwd: workspaceRoot,
  },
  projects: [{ name: 'chromium' }],
});
