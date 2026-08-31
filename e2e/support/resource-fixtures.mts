import type {
  Fixtures,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
} from '@playwright/test';
import type {
  E2EResourceFixtures,
  E2EWorkerFixtures,
} from './composition-fixture.types.mts';
import {
  createTestResourceNamespace,
  withTestResourceNamespace,
} from './namespace.mts';
import { readSession } from './session.mts';
import { MatrixTestResources } from './test-resources.mts';

/** Attempt-scoped resource ownership shared by every Playwright lifecycle. */
export const resourceFixtureDefinitions: Fixtures<
  E2EResourceFixtures,
  E2EWorkerFixtures,
  PlaywrightTestArgs & PlaywrightTestOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
> = {
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
};
