import type {
  Page,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestType,
} from '@playwright/test';
import type { TestResourceNamespace } from './namespace.mts';
import type { AuthPlatform, TouchPlatform } from './platform-contracts.mts';
import type { MatrixTestResources } from './test-resources.mts';

export interface SecondaryApp {
  launch(): Promise<Page>;
  activatePrimary(): Promise<void>;
}

export interface E2EPlatformFixtures {
  authPlatform: AuthPlatform;
  secondaryApp: SecondaryApp;
  touchPlatform: TouchPlatform;
}

export interface E2EResourceFixtures {
  matrixResources: MatrixTestResources;
  resourceCleanup: void;
  resourceNamespace: TestResourceNamespace;
}

export type E2ETestFixtures = E2EPlatformFixtures & E2EResourceFixtures;

export interface E2EWorkerFixtures {
  workerResourceNamespace: TestResourceNamespace;
}

export type E2ECompositionTest = TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & E2ETestFixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions & E2EWorkerFixtures
>;
