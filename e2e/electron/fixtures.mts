import {
  expect,
  test as environmentTest,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import {
  createTestResourceNamespace,
  testResourceId,
  type TestResourceNamespace,
  withTestResourceNamespace,
} from '../support/namespace.mts';
import { readSession } from '../support/session.mts';
import { MatrixTestResources } from '../support/test-resources.mts';

/** Electron owns its runner adapter while reusing only support-level test resources. */
export const test = environmentTest.extend<{
  matrixResources: MatrixTestResources;
  resourceCleanup: void;
  resourceNamespace: TestResourceNamespace;
}>({
  resourceNamespace: [
    async ({}, use, testInfo) => {
      const namespace = createTestResourceNamespace({
        sessionId: readSession().id,
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

export { expect, testResourceId };
export type { APIRequestContext, Page };
