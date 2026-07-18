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
  // This config lives in the `trinity-e2e` project (e2e/), so the @nx/playwright
  // plugin infers the `e2e` target here and the web specs sit within the project
  // root at e2e/playwright/.
  ...nxE2EPreset(import.meta.dirname, { testDir: './playwright' }),
  // Retry transient failures. Every spec drives one shared disposable Synapse, so
  // under full-suite parallelism the initial /sync and server round-trips (a room
  // appearing in the list, a rename/receipt propagating) can briefly exceed their
  // per-step timeouts. A retry re-runs when contention has eased; a genuine bug
  // still fails all attempts, and Playwright reports the retried ones as "flaky".
  // Pairs with `trace: 'on-first-retry'` below.
  retries: 2,
  // Every spec drives the same single disposable Synapse; the default worker count
  // (≈half the cores) oversubscribes it, and the resulting slow /sync + round-trips
  // are what make the sync-dependent specs flaky. Cap at 2 to keep the homeserver
  // responsive — trades some wall-clock for a materially steadier run.
  workers: 2,
  // Bring up / tear down the disposable Synapse homeserver (Docker). Gracefully
  // skips when Docker is unavailable; auth-only specs skip themselves then.
  globalSetup: './playwright/support/global-setup.mts',
  globalTeardown: './playwright/support/global-teardown.mts',
  use: {
    baseURL,
    // Accept the disposable Synapse + Caddy self-signed cert (the app CSP only
    // allows https:/wss: for connect-src, so the HS must be served over TLS).
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
  },
  webServer: {
    command:
      'pnpm exec nx run trinity:build:development && node e2e/playwright/support/serve-www.mjs',
    url: baseURL,
    reuseExistingServer: !process.env['CI'],
    timeout: 240_000,
    cwd: workspaceRoot,
  },
  // Chromium only: the app ships to Capacitor/Electron (Blink/WebKit) WebViews;
  // these UI journeys are representative in Chromium, matching the legacy harness.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
