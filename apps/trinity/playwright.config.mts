import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

// Base URL of the app under test. The webServer below builds the dev bundle and
// serves www/ statically (the same proven path the legacy e2e/ harness uses — it
// serves the crypto WASM at /assets/crypto/, which the in-app E2EE init needs).
const baseURL = process.env['BASE_URL'] || 'http://localhost:4200';

/**
 * See https://playwright.dev/docs/test-configuration.
 *
 * `.mts` so Node forces ESM regardless of workspace `type`; Playwright routes it
 * through its ESM loader and Nx's TS strip loads it directly.
 */
export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './e2e' }),
  // Bring up / tear down the disposable Synapse homeserver (Docker). Gracefully
  // skips when Docker is unavailable; auth-only specs skip themselves then.
  globalSetup: './e2e/support/global-setup.mts',
  globalTeardown: './e2e/support/global-teardown.mts',
  use: {
    baseURL,
    // Accept the disposable Synapse + Caddy self-signed cert (the app CSP only
    // allows https:/wss: for connect-src, so the HS must be served over TLS).
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
  },
  webServer: {
    command:
      'pnpm exec nx run trinity:build:development && node apps/trinity/e2e/support/serve-www.mjs',
    url: baseURL,
    reuseExistingServer: !process.env['CI'],
    timeout: 240_000,
    cwd: workspaceRoot,
  },
  // Chromium only: the app ships to Capacitor/Electron (Blink/WebKit) WebViews;
  // these UI journeys are representative in Chromium, matching the legacy harness.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
