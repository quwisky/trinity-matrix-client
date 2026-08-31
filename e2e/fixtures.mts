import {
  devices,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import {
  createTestResourceNamespace,
  testResourceId,
  withTestResourceNamespace,
} from './support/namespace.mts';
import type {
  E2EResourceFixtures,
  E2EWorkerFixtures,
} from './support/composition-fixture.types.mts';
import { readSession } from './support/session.mts';
import { MatrixTestResources } from './support/test-resources.mts';

/**
 * Composition-edge fixture selection. Environment adapters depend inward on shared
 * contracts; only this entrypoint chooses one adapter for the current invocation.
 */
const adapter =
  process.env['TRINITY_E2E_PLATFORM'] === 'android'
    ? await import('./android/fixtures.mts')
    : await import('./web-fixtures.mts');

const environmentTest =
  adapter.test as typeof import('./android/fixtures.mts').test;

export const test = environmentTest.extend<
  E2EResourceFixtures,
  E2EWorkerFixtures
>({
  workerResourceNamespace: [
    async ({}, use, workerInfo) => {
      const namespace = createTestResourceNamespace({
        sessionId: readSession().id,
        suiteId: workerInfo.project.name,
        workerIndex: workerInfo.workerIndex,
        testId: 'worker-shared',
        retry: 0,
      });
      await use(namespace);
      await namespace.cleanup();
    },
    { scope: 'worker' },
  ],
  resourceNamespace: [
    async ({}, use, testInfo) => {
      const sessionId = readSession().id;
      const namespace = createTestResourceNamespace({
        sessionId,
        suiteId: testInfo.project.name,
        workerIndex: testInfo.workerIndex,
        testId: testInfo.testId,
        retry: testInfo.retry,
      });
      await withTestResourceNamespace(namespace, () => use(namespace));
    },
    { auto: true },
  ],
  resourceCleanup: [
    async ({ request, resourceNamespace }, use) => {
      void request;
      await use();
      await resourceNamespace.cleanup();
    },
    { auto: true },
  ],
  matrixResources: async ({ resourceNamespace }, use) => {
    await use(new MatrixTestResources(resourceNamespace));
  },
});
export { devices, expect, testResourceId };
export type { APIRequestContext, Locator, Page, Route };
