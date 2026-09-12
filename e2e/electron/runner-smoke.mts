import { test } from 'node:test';
import { join } from 'node:path';
import { readSession } from '../support/session.mts';
import { openElectronSession } from '../support/electron-session.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { createNodeAccount } from '../support/node-account.mts';
import { signInRunnerSmoke } from '../support/runner-smoke-journey.mts';

void test(
  'Electron runner signs in through the installed host',
  { timeout: 120_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const account = await createNodeAccount(matrixResources, signal);
        const host = await openElectronSession({
          workspace: session.workspaceRoot,
          artifact: join(session.workspaceRoot, 'electron'),
          signal,
          binaryPaths: {
            electron:
              process.env['TRINITY_ELECTRON_BINARY'] ??
              join(
                session.workspaceRoot,
                'electron/node_modules/electron/dist/electron',
              ),
            chromedriver: process.env['TRINITY_ELECTRON_CHROMEDRIVER_BINARY']!,
          },
        });
        matrixResources.cleanup('Electron session', () => host.close());
        await signInRunnerSmoke(
          host.browser,
          account,
          join(process.env['TRINITY_E2E_REPORT_DIR']!, 'electron'),
        );
      },
    );
  },
);
