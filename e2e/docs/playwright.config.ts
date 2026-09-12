import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = 4178;
const pagesBase = '/trinity-matrix-client';
const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: 'documentation.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    [
      'html',
      {
        open: 'never',
        outputFolder: join(workspaceRoot, 'dist/.playwright/docs-site/html'),
      },
    ],
  ],
  outputDir: join(workspaceRoot, 'dist/.playwright/docs-site/results'),
  use: {
    baseURL: `http://127.0.0.1:${port}${pagesBase}/`,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `pnpm nx run docs-site:assemble && node tools/docs/serve-static.mjs --root dist/docs-site --base ${pagesBase} --port ${port}`,
    url: `http://127.0.0.1:${port}${pagesBase}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: workspaceRoot,
  },
});
