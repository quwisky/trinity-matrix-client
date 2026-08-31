import {
  test as baseTest,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import type {
  E2EResourceFixtures,
  E2EWorkerFixtures,
} from '../support/composition-fixture.types.mts';
import { registerUser } from '../support/account.mts';
import { resourceFixtureDefinitions } from '../support/resource-fixtures.mts';
import { readSession } from '../support/session.mts';
import {
  protocolCase,
  protocolMode,
  protocolSuite,
  remoteProtocolCredentials,
  selectedProtocolSuiteId,
  type ProtocolCredentials,
} from './runtime.mts';

interface ProtocolFixtures {
  protocolCredentials: ProtocolCredentials;
  protocolMetadata: void;
}

const resourceTest = baseTest.extend<E2EResourceFixtures, E2EWorkerFixtures>(
  resourceFixtureDefinitions,
);

export const test = resourceTest.extend<ProtocolFixtures>({
  protocolMetadata: [
    async ({}, use, testInfo) => {
      const suite = protocolSuite(selectedProtocolSuiteId());
      for (const capability of suite.capabilities) {
        testInfo.annotations.push({
          type: 'trinity.e2e.capability',
          description: capability,
        });
      }
      for (const contractType of suite.contractTypes) {
        testInfo.annotations.push({
          type: 'trinity.e2e.contractType',
          description: contractType,
        });
      }
      await use();
    },
    { auto: true },
  ],
  protocolCredentials: async ({ matrixResources, request }, use) => {
    const id = selectedProtocolSuiteId();
    if (protocolMode() === 'remote') {
      await use(remoteProtocolCredentials(id));
      return;
    }

    const synapse = readSession().synapse;
    if (!synapse?.available || !synapse.hs) {
      throw new Error(
        `${id} requires the disposable Synapse invocation in disposable mode`,
      );
    }
    const user = matrixResources.userLocalpart('primary');
    const pass = 'trinity-protocol-pass-123';
    await registerUser(request, user, pass);
    const secondary = protocolCase(id).secondaryAccount
      ? {
          user: matrixResources.userLocalpart('secondary'),
          pass: 'trinity-protocol-secondary-pass-123',
        }
      : undefined;
    if (secondary) {
      await registerUser(request, secondary.user, secondary.pass);
    }
    await use({
      mode: 'disposable',
      hs: synapse.hs,
      user,
      pass,
      secondary,
    });
  },
});

export { expect };
export type { APIRequestContext, Locator, Page, Route };
