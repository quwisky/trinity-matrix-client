import type { PlaywrightTestConfig } from '@playwright/test';
import { workspaceRoot } from '@nx/devkit';

/**
 * Shared real-application lifecycle for browser suites backed by disposable Synapse.
 *
 * Config files remain responsible for their own projects, reporters and concurrency. The
 * security-sensitive server origin, TLS policy, build command and Synapse ownership live here so
 * a small evidence suite cannot silently drift from the canonical app journeys.
 */
export function appE2EConfig(
  baseURL: string,
  options: { reuseExistingServer?: boolean } = {},
): Pick<
  PlaywrightTestConfig,
  'globalSetup' | 'globalTeardown' | 'use' | 'webServer'
> {
  const serveCommand = process.env['TRINITY_E2E_PREBUILT_WWW']
    ? 'node e2e/playwright/support/serve-www.mjs'
    : 'pnpm exec nx run trinity:build:development && node e2e/playwright/support/serve-www.mjs';
  return {
    globalSetup: './playwright/support/global-setup.mts',
    globalTeardown: './playwright/support/global-teardown.mts',
    use: {
      baseURL,
      ignoreHTTPSErrors: true,
      trace: 'retain-on-failure',
    },
    webServer: {
      command: serveCommand,
      url: baseURL,
      reuseExistingServer: options.reuseExistingServer ?? !process.env['CI'],
      timeout: 240_000,
      cwd: workspaceRoot,
    },
  };
}
