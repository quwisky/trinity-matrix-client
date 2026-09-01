export type E2EEnvironment =
  'android' | 'browser' | 'components' | 'electron' | 'protocol' | 'web';

export type E2EContractType =
  'accessibility' | 'host' | 'journey' | 'protocol' | 'security' | 'visual';

export type E2ECapability =
  | 'accounts'
  | 'composition'
  | 'conversations'
  | 'cross-capability'
  | 'design-system'
  | 'discovery'
  | 'discovery-search'
  | 'host'
  | 'host-shell'
  | 'identity'
  | 'matrix-runtime'
  | 'media'
  | 'notifications'
  | 'room-administration'
  | 'room-library'
  | 'search'
  | 'settings'
  | 'trust'
  | 'workspace';

export type E2ECiTier = 'local-only' | 'pull-request' | 'scheduled';
export type E2ETimeoutClass = 'short' | 'medium' | 'long' | 'host';

export type E2EPrerequisite =
  | 'android-avd'
  | 'android-sdk'
  | 'docker'
  | 'electron'
  | 'java-21'
  | 'kvm'
  | 'network'
  | 'playwright-chromium'
  | 'playwright-firefox'
  | 'playwright-webkit'
  | 'xvfb';

export interface E2ESuiteDefinition {
  readonly id: string;
  readonly environment: E2EEnvironment;
  readonly capabilities: readonly E2ECapability[];
  readonly contractTypes: readonly E2EContractType[];
  readonly currentTarget: `${string}:${string}`;
  readonly delegatingTargets?: readonly `${string}:${string}`[];
  readonly targetProject: string;
  readonly prerequisites: readonly E2EPrerequisite[];
  readonly availabilityPolicy: 'required' | 'optional';
  readonly ciTier: E2ECiTier;
  readonly cachePolicy: 'never';
  readonly serializationKeys: readonly string[];
  readonly timeoutClass: E2ETimeoutClass;
  readonly canonicalScript: string;
  readonly currentArtifactRoot: string;
  readonly targetArtifactRoot: string;
  readonly sourceEntrypoints: readonly string[];
}

export interface E2ESerializationResource {
  readonly key: string;
  readonly owner: 'trinity-e2e-support';
  readonly description: string;
}

export interface E2EPackageScriptContract {
  readonly name: string;
  readonly command: string;
  readonly kind: 'canonical' | 'compatibility' | 'maintenance';
  readonly suiteIds: readonly string[];
  readonly removalAfterRelease?: string;
}

export interface E2EAggregateTarget {
  readonly target: string;
  readonly unavailablePolicy: 'fail' | 'skip';
  readonly selection:
    | { readonly kind: 'all' }
    | { readonly kind: 'ci-tier'; readonly value: E2ECiTier }
    | { readonly kind: 'environment'; readonly value: E2EEnvironment };
}

export interface E2ECiEntrypoint {
  readonly command: string;
  readonly tier: Exclude<E2ECiTier, 'local-only'>;
  readonly suiteIds: readonly string[];
}

export interface E2EQuarantineEntry {
  readonly suiteId: string;
  readonly issue: string;
  readonly owner: string;
  readonly reason: string;
  readonly expiresOn: string;
  readonly excludedTier: E2ECiTier;
}

export const defineSuites = <const T extends readonly E2ESuiteDefinition[]>(
  suites: T,
): T => suites;
