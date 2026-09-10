import type { E2ESuiteDefinition } from '../../support/e2e-registry.types.mts';
import {
  BROWSER_CAPABILITIES,
  BROWSER_CONTRACT_TYPES,
} from '../browser-classification.mts';

/** Browser ownership metadata consumed by the aggregate registry and config. */
export const BROWSER_E2E_SUITES = [
  {
    id: 'browser.canonical',
    environment: 'browser',
    capabilities: BROWSER_CAPABILITIES,
    contractTypes: BROWSER_CONTRACT_TYPES,
    runner: 'playwright',
    currentTarget: 'trinity-e2e-browser:e2e',
    targetProject: 'trinity-e2e-browser',
    prerequisites: ['docker', 'playwright-chromium'],
    availabilityPolicy: 'required',
    ciTier: 'pull-request',
    ciRetries: 1,
    cachePolicy: 'never',
    serializationKeys: ['synapse'],
    timeoutClass: 'long',
    canonicalScript: 'e2e:browser',
    currentArtifactRoot: 'dist/.playwright/trinity-e2e-browser/<run-id>',
    targetArtifactRoot: 'dist/.playwright/trinity-e2e-browser/<run-id>',
    sourceEntrypoints: ['e2e/browser/playwright.config.mts'],
  },
] as const satisfies readonly E2ESuiteDefinition[];

export const BROWSER_CANONICAL_SUITE = BROWSER_E2E_SUITES[0];
