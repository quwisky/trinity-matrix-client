import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import { AccountWorkspaceClient } from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import {
  openMaestroDevice,
  redactMaestroArtifacts,
} from './maestro-session.mts';
import { spaceSettingsCoreAdminCases } from './space-settings-core-admin-journeys.mts';
import { spaceSettingsCoreContentsCase } from './space-settings-core-contents-journey.mts';
import { spaceSettingsCoreAssertions } from './space-settings-core-contract.mts';
import { spaceSettingsCorePermissionCases } from './space-settings-core-permissions-journeys.mts';

const cases = [
  ...spaceSettingsCoreAdminCases,
  spaceSettingsCoreContentsCase,
  ...spaceSettingsCorePermissionCases,
];
assert.equal(
  cases.length,
  7,
  'All seven core Space Settings definitions are required',
);
assert.equal(new Set(cases.map((entry) => entry.id)).size, 7);
assert.equal(
  Object.keys(spaceSettingsCoreAssertions).length,
  85,
  'Exactly 85 core Space Settings assertion identities are required',
);

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

void test(
  'Android core Space Settings administration journeys',
  { timeout: 2_400_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'space-settings-core',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {};
        const baseFixtures = createAccountFixtures(matrixResources, signal);
        const fixtures: typeof baseFixtures = {
          ...baseFixtures,
          account: async (...args) => {
            const account = await baseFixtures.account(...args);
            secrets[`PASSWORD_${account.username}`] = account.password;
            return account;
          },
        };
        // Cleanup runs in reverse order: WebView, device diagnostics, redaction.
        matrixResources.cleanup('Redact core Space Settings diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const stages: Array<{
          id: string;
          source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify({ expectedStages: cases.length, expectedAssertions: Object.keys(spaceSettingsCoreAssertions).length, stages }, null, 2)}\n`,
          );
        await save();
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Core Space Settings Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Core Space Settings Android WebView',
          async () => client?.close(),
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/debug/app-debug.apk',
          ),
        );
        for (const entry of cases) {
          const directory = join(output, entry.id);
          await mkdir(directory, { recursive: true });
          client = new AccountWorkspaceClient(
            device,
            session.workspaceRoot,
            directory,
            signal,
          );
          const stage: (typeof stages)[number] = {
            id: entry.id,
            source: entry.source,
            status: 'running',
            durationMs: 0,
            artifact: `${entry.id}/*`,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          console.info(`[space-settings-core] ${entry.id} start`);
          try {
            assert(entry.profile, `${entry.id} declares its canonical profile`);
            await client.reset(entry.profile);
            await entry.run({
              client,
              fixtures,
              resources: matrixResources,
              signal,
            });
            await client.capture('passed');
          } catch (error) {
            failures.push(error);
            try {
              await client.capture('failed');
            } catch (captureError) {
              failures.push(captureError);
            }
          } finally {
            try {
              await client.close();
            } catch (error) {
              failures.push(error);
            }
            client = undefined;
          }
          stage.durationMs = performance.now() - started;
          stage.failureCount = failures.length;
          stage.status = failures.length ? 'failed' : 'passed';
          if (failures.length)
            stage.error = failures.map(describeFailure).join('\n');
          try {
            await save();
          } catch (error) {
            failures.push(error);
          }
          console.info(
            `[space-settings-core] ${entry.id} end ${stage.status} ${Math.round(stage.durationMs)}ms`,
          );
          if (failures.length)
            throw new AggregateError(failures, `${entry.id} failed`);
        }
        assert.equal(
          stages.filter((stage) => stage.status === 'passed').length,
          7,
        );
      },
    );
  },
);
