import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSession } from '../support/session.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import { AccountWorkspaceClient } from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import { accountLifecycleCases } from './account-lifecycle-journeys.mts';
import { mixedAccountWorkspaceCases } from './mixed-account-workspace-journeys.mts';

const cases = [...accountLifecycleCases, ...mixedAccountWorkspaceCases];
assert.equal(cases.length, 14, 'All canonical account definitions are required');
assert.equal(new Set(cases.map(entry => entry.id)).size, cases.length);

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError ? `${message}\n${error.errors.map(describeFailure).join('\n')}` : message;
}

void test('Android account lifecycle and mixed workspace journeys', { timeout: 4_500_000 }, async context => {
  await withNodeTestResources({ testId: context.name, signal: context.signal }, async ({ matrixResources, signal }) => {
    const session = readSession();
    const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ?? join(session.workspaceRoot, 'dist/.playwright'), 'accounts-workspace');
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
    // Cleanup runs in reverse registration order: client, device diagnostics, redaction.
    matrixResources.cleanup('Redact account diagnostics', () => redactMaestroArtifacts(output, secrets));
    const device = await openMaestroDevice({ workspaceRoot: session.workspaceRoot, signal, artifactDirectory: output, serial: process.env['TRINITY_ANDROID_SERIAL'] });
    matrixResources.cleanup('Account Android device', () => device.close());
    let client: AccountWorkspaceClient | undefined;
    matrixResources.cleanup('Account WebView', async () => client?.close());
    await device.install(join(session.workspaceRoot, 'android/app/build/outputs/apk/debug/app-debug.apk'));
    const stages: { id: string; source: string; status: 'running' | 'passed' | 'failed'; durationMs: number; error?: string; artifact: string }[] = [];
    const save = async (): Promise<void> => writeFile(join(output, 'journeys.json'), `${JSON.stringify({ expectedCases: cases.length, stages }, null, 2)}\n`);
    for (const entry of cases) {
      const directory = join(output, entry.id);
      await mkdir(directory, { recursive: true });
      client = new AccountWorkspaceClient(device, session.workspaceRoot, directory, signal);
      const stage: (typeof stages)[number] = { id: entry.id, source: entry.source, status: 'running', durationMs: 0, artifact: `${entry.id}/*` };
      stages.push(stage);
      await save();
      const started = performance.now();
      console.info(`[accounts] ${entry.id} start`);
      const failures: unknown[] = [];
      try {
        await client.reset(entry.profile);
        await entry.run({ client, fixtures, resources: matrixResources, signal });
        await client.capture('passed');
      } catch (error) {
        failures.push(error);
        try { await client.capture('failed'); } catch (diagnosticError) { failures.push(diagnosticError); }
      } finally {
        try { await client.close(); } catch (error) { failures.push(error); }
        stage.status = failures.length ? 'failed' : 'passed';
        stage.durationMs = performance.now() - started;
        if (failures.length) stage.error = failures.map(describeFailure).join('\n');
        console.info(`[accounts] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`);
        await save();
      }
      if (failures.length) throw new AggregateError(failures, `Account journey ${entry.id} failed`);
    }
    assert.equal(stages.filter(stage => stage.status === 'passed').length, 14);
  });
});
