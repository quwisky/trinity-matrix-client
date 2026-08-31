import type { PlaywrightTestConfig } from '@playwright/test';

/**
 * Shared real-application lifecycle for browser suites backed by disposable Synapse.
 *
 * Config files remain responsible for their own projects, reporters and concurrency. The
 * security-sensitive server origin, TLS policy, build command and Synapse ownership live here so
 * a small evidence suite cannot silently drift from the canonical app journeys.
 */
export function appE2EConfig(
  baseURL: string,
): Pick<PlaywrightTestConfig, 'use'> {
  return {
    use: {
      baseURL,
      ignoreHTTPSErrors: true,
      trace: 'retain-on-failure',
    },
  };
}
