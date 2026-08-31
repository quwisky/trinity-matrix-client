import { defineSuites } from '../types.mts';

export const BROWSER_E2E_SUITES = defineSuites([
  {
    id: 'browser.canonical',
    environment: 'browser',
    capabilities: ['cross-capability'],
    contractTypes: ['journey', 'security'],
    currentTarget: 'trinity-e2e:e2e',
    targetProject: 'trinity-e2e-browser',
    prerequisites: ['docker', 'playwright-chromium'],
    ciTier: 'pull-request',
    cachePolicy: 'never',
    serializationKeys: ['synapse'],
    timeoutClass: 'long',
    canonicalScript: 'e2e:browser',
    currentArtifactRoot: 'dist/.playwright/trinity-e2e-browser/<run-id>',
    targetArtifactRoot: 'dist/.playwright/trinity-e2e-browser/<run-id>',
    sourceEntrypoints: ['e2e/playwright.config.mts'],
  },
]);
