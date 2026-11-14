import { defineSuites } from '../../support/e2e-registry.types.mts';

const artifactRoot = 'dist/.playwright/trinity-site-shots/<run-id>';

/** Landing-page captures: run by hand or by the release capture workflow, never on pull requests. */
export const SITE_E2E_SUITES = defineSuites([
  {
    id: 'site.shots',
    environment: 'site',
    capabilities: ['cross-capability'],
    contractTypes: ['visual'],
    currentTarget: 'trinity-site-shots:capture',
    // The release workflow serves a tag's own build from www/ instead of building main.
    delegatingTargets: ['trinity-site-shots:capture-prebuilt'],
    targetProject: 'trinity-site-shots',
    prerequisites: ['docker', 'playwright-chromium'],
    availabilityPolicy: 'optional',
    ciTier: 'local-only',
    cachePolicy: 'never',
    serializationKeys: ['homeserver'],
    timeoutClass: 'long',
    canonicalScript: 'e2e:site-shots',
    currentArtifactRoot: artifactRoot,
    targetArtifactRoot: artifactRoot,
    sourceEntrypoints: ['e2e/site-shots/playwright.config.mts'],
  },
]);
