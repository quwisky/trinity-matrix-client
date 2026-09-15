import { test } from 'node:test';
import { join } from 'node:path';
import { readSession } from '../support/session.mts';
import { openChromeSession } from '../support/webdriver-session.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { createNodeAccount } from '../support/node-account.mts';
import { signInRunnerSmoke } from '../support/runner-smoke-journey.mts';

void test(
  'Chromium runner signs in through the rendered application',
  { timeout: 120_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const account = await createNodeAccount(matrixResources, signal);
        const host = await openChromeSession({
          workspace: session.workspaceRoot,
          artifact: session.endpoints.application,
          signal,
          binaryPaths: {
            chrome: process.env['TRINITY_CHROME_BINARY']!,
            chromedriver: process.env['TRINITY_CHROMEDRIVER_BINARY']!,
          },
        });
        matrixResources.cleanup('Chromium session', () => host.close());
        await signInRunnerSmoke(
          host.browser,
          account,
          join(process.env['TRINITY_E2E_REPORT_DIR']!, 'chromium'),
        );
      },
    );
  },
);
