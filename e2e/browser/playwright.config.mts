import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { appE2EConfig } from './support/app-e2e-config.mts';
import { BROWSER_CANONICAL_SUITE } from '../registry/suites/browser.mts';
import {
  e2eEndpoint,
  e2eArtifactPath,
  e2eReportConfig,
} from '../support/playwright-config.mts';

// Base URL of the invocation-owned development artifact server. The config is a
// fail-closed joiner and never starts or tears down application infrastructure.
const baseURL = e2eEndpoint('application');
const browserSuite = BROWSER_CANONICAL_SUITE;

/**
 * See https://playwright.dev/docs/test-configuration.
 *
 * `.mts` so Node forces ESM regardless of workspace `type`; Playwright routes it
 * through its ESM loader and Nx's TS strip loads it directly.
 */
export default defineConfig({
  // Capability directories are independently focusable through the project target,
  // while one project-level invocation keeps the fixed Synapse lifecycle serialized.
  ...nxE2EPreset(import.meta.dirname, { testDir: './journeys' }),
  // Retry transient failures. Every spec drives one shared disposable Synapse, so
  // under full-suite parallelism the initial /sync and server round-trips (a room
  // appearing in the list, a rename/receipt propagating) can briefly exceed their
  // per-step timeouts. A retry re-runs when contention has eased; a genuine bug
  // still fails all attempts, and Playwright reports the retried ones as "flaky".
  // Pairs with `trace: 'retain-on-failure'` below.
  retries: 2,
  // Every spec drives the same single disposable Synapse; the default worker count
  // (≈half the cores) oversubscribes it, and the resulting slow /sync + round-trips
  // are what make the sync-dependent specs flaky. Cap at 2 to keep the homeserver
  // responsive — trades some wall-clock for a materially steadier run.
  workers: 2,
  // Per-test budget. Playwright's 30s default is too tight for these login-heavy Matrix
  // flows: a cold UI login (Rust-crypto init + first /sync ≈ 15-40s under load) plus a
  // state-event sync echo can exceed it mid-wait, which surfaced as flakes across the
  // event-propagation specs (rename, reactions, polls, threads). 120s (well under the
  // outer invocation budget) gives realistic headroom; retries still catch the rare tail.
  timeout: 120_000,
  ...e2eReportConfig(browserSuite, {
    reportersAfterMetadata: [
      [
        join(import.meta.dirname, 'capability-coverage.reporter.mts'),
        {
          outputFile: e2eArtifactPath(
            browserSuite.targetProject,
            browserSuite.id,
            'capability-coverage/coverage.json',
          ),
        },
      ],
    ],
  }),
  // Shared with the current-interface evidence suite: Synapse lifecycle, app server, self-signed
  // TLS policy and retain-on-failure traces must not drift between real-app browser harnesses.
  ...appE2EConfig(baseURL),
  // Chromium only: the app ships to Capacitor/Electron (Blink/WebKit) WebViews;
  // these UI journeys are representative in Chromium, matching the legacy harness.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
