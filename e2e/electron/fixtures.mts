import { writeFile } from 'node:fs/promises';
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
import { electronDiagnostics } from './support/launch.mts';

/** Electron owns its runner adapter while reusing only support-level test resources. */
export const test = environmentTest.extend<{
  electronFailureDiagnostics: void;
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
  // CI keeps no renderer output for an attached Electron page, so a failure records it.
  electronFailureDiagnostics: [
    async ({}, use, testInfo) => {
      await use();
      if (testInfo.status === testInfo.expectedStatus) return;
      // A file, not a body: reporters truncate inline text and the DOM is the point.
      const path = testInfo.outputPath('electron-diagnostics.txt');
      await writeFile(path, await electronDiagnostics());
      await testInfo.attach('electron-diagnostics', {
        path,
        contentType: 'text/plain',
      });
    },
    { auto: true },
  ],
  matrixResources: async ({ resourceNamespace }, use) => {
    await use(new MatrixTestResources(resourceNamespace));
  },
});

export { expect, testResourceId };
export type { APIRequestContext, Page };
