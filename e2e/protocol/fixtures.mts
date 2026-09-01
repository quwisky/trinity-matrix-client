import {
  test as baseTest,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import type {
  E2EResourceFixtures,
  E2EWorkerFixtures,
} from '../support/composition-fixture.types.mts';
import { registerUser } from '../support/account.mts';
import { waitForRooms } from '../support/app.mts';
import { resourceFixtureDefinitions } from '../support/resource-fixtures.mts';
import { applicationOrigin, readSession } from '../support/session.mts';
import {
  redactProtocolDiagnostic,
  redactProtocolError,
} from './diagnostics.mts';
import {
  protocolCase,
  protocolMode,
  protocolSuite,
  remoteProtocolCredentials,
  selectedProtocolSuiteId,
  type ProtocolCredentials,
} from './runtime.mts';

interface ProtocolCredentialFixtures {
  protocolCredentials: ProtocolCredentials;
  protocolBrowser: ProtocolBrowser;
  protocolDiagnostics: void;
}

interface ProtocolMetadataFixtures {
  protocolMetadata: void;
}

interface ProtocolPageOptions {
  readonly label?: string;
  readonly credentials?: Pick<ProtocolCredentials, 'user' | 'pass'>;
}

export interface ProtocolBrowser {
  newPage(options?: Pick<ProtocolPageOptions, 'label'>): Promise<Page>;
  newAuthenticatedPage(options?: ProtocolPageOptions): Promise<Page>;
  login(
    page: Page,
    credentials?: Pick<ProtocolCredentials, 'user' | 'pass'>,
  ): Promise<void>;
  redact(value: unknown): string;
}

async function fillLabeledInput(
  page: Page,
  label: string,
  value: string,
): Promise<void> {
  const input = page.getByLabel(label, { exact: true });
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.click();
  await input.fill(value);
}

async function login(
  page: Page,
  homeserver: string,
  credentials: Pick<ProtocolCredentials, 'user' | 'pass'>,
): Promise<void> {
  await page.goto(`${applicationOrigin()}/login`, { waitUntil: 'networkidle' });
  await fillLabeledInput(page, 'Homeserver', homeserver);
  await page.getByText('Continue', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Sign in' })
    .waitFor({ timeout: 30_000 });
  await fillLabeledInput(page, 'Username', credentials.user);
  await fillLabeledInput(page, 'Password', credentials.pass);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await waitForRooms(page);
}

const resourceTest = baseTest.extend<E2EResourceFixtures, E2EWorkerFixtures>(
  resourceFixtureDefinitions,
);

const protocolTest = resourceTest.extend<ProtocolMetadataFixtures>({
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
});

/** Protocol checks that intentionally own no Homeserver or Account credentials. */
export const standaloneTest = protocolTest;

/** Protocol journeys whose diagnostics must redact attempt-scoped credentials. */
export const test = protocolTest.extend<ProtocolCredentialFixtures>({
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
  protocolBrowser: async ({ browser, protocolCredentials }, use) => {
    const contexts: BrowserContext[] = [];
    const remote = protocolCredentials.mode === 'remote';
    const redact = (value: unknown): string =>
      redactProtocolDiagnostic(value, protocolCredentials);
    try {
      const newPage = async (
        options: Pick<ProtocolPageOptions, 'label'> = {},
      ): Promise<Page> => {
        const label = options.label ?? 'page';
        const context = await browser.newContext({
          ignoreHTTPSErrors: !remote,
          viewport: { width: 1280, height: 720 },
        });
        contexts.push(context);
        await context.route(`${protocolCredentials.hs}/**`, async (route) => {
          try {
            const response = await route.fetch();
            await route.fulfill({ response });
          } catch {
            await route.fallback();
          }
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => {
          console.log(
            remote
              ? `  [${label}:error] remote page error (details suppressed)`
              : `  [${label}:error] ${redact(error.message)}`,
          );
        });
        page.on('console', (message) => {
          if (message.type() !== 'error') return;
          console.log(
            remote
              ? `  [${label}:console.error] remote output suppressed`
              : `  [${label}:console.error] ${redact(message.text())}`,
          );
        });
        return page;
      };
      await use({
        redact,
        newPage,
        login: (page, credentials = protocolCredentials) =>
          login(page, protocolCredentials.hs, credentials),
        newAuthenticatedPage: async (options = {}) => {
          const page = await newPage(options);
          await login(
            page,
            protocolCredentials.hs,
            options.credentials ?? protocolCredentials,
          );
          return page;
        },
      });
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  },
  protocolDiagnostics: [
    async ({ protocolCredentials }, use) => {
      try {
        await use();
      } catch (error) {
        throw redactProtocolError(error, protocolCredentials);
      }
    },
    { auto: true },
  ],
});

export { expect };
export type { APIRequestContext, Locator, Page, Route };
