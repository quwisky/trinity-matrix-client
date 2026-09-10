import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readSession } from '../support/session.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { createNodeAccount } from '../support/node-account.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { openMaestroWebview } from './maestro-webview.mts';

void test(
  'Maestro runner signs in through the installed Android app',
  { timeout: 360_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const account = await createNodeAccount(matrixResources, signal);
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: join(
            process.env['TRINITY_E2E_REPORT_DIR']!,
            'android',
          ),
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Android device', () => device.close());
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/debug/app-debug.apk',
          ),
        );
        await device.adb('shell', 'pm', 'clear', 'eu.qwky.trinity');
        await device.adb(
          'shell',
          'pm',
          'grant',
          'eu.qwky.trinity',
          'android.permission.POST_NOTIFICATIONS',
        );
        await device.launch();
        // The initial debug socket can belong to a startup WebView. Observe
        // the native login form before binding diagnostics and its TLS exception.
        await device.runFlow(
          join(session.workspaceRoot, 'e2e/android/flows/runner-ready.yaml'),
        );
        const webview = await openMaestroWebview(device, { signal });
        matrixResources.cleanup('Android WebView diagnostics', () =>
          webview.close(),
        );
        await device.runFlow(
          join(session.workspaceRoot, 'e2e/android/flows/runner-smoke.yaml'),
          {
            HOMESERVER: account.homeserver,
            USERNAME: account.username,
            PASSWORD: account.password,
          },
        );
        const evaluation = await webview.diagnostics.send('Runtime.evaluate', {
          expression: 'document.body.innerText',
          returnByValue: true,
        });
        assert(
          typeof evaluation === 'object' &&
            evaluation !== null &&
            !('exceptionDetails' in evaluation) &&
            'result' in evaluation,
          'Android diagnostic evaluation succeeds',
        );
        const result = evaluation.result;
        assert(
          typeof result === 'object' && result !== null && 'value' in result,
        );
        const body = result.value;
        assert(
          typeof body === 'string' &&
            body.includes('Recent activity') &&
            body.includes(account.username),
          'Authenticated native Rooms shows the registered account',
        );
      },
    );
  },
);
