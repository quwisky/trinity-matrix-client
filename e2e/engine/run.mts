#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  suiteSummaryPath,
  wdioSuiteSummary,
} from '../support/execution-report.mts';
import { openE2EInvocation } from '../support/invocation.mts';
import {
  createProcessTerminationScope,
  runManagedCommand,
} from '../support/managed-command.mts';
import {
  IDENTITY_SERVER_URL,
  MAILPIT_HTTP,
  REGISTRATION_SHARED_SECRET,
  SERVER_NAME,
} from '../support/homeserver/start.mjs';
import { evaluateVitestReport } from './report.mts';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LIBS = [
  'data-access-homeserver',
  'data-access-discovery',
  'data-access-matrix-client',
  'data-access-room-library',
  'data-access-timeline',
  'data-access-widgets',
  'data-access-media',
  'data-access-notifications',
  'data-access-room-administration',
  'data-access-trust',
  'data-access-contact-addresses',
  'data-access-auth',
] as const;

export async function runEngineContract(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const termination = createProcessTerminationScope();
  const startedAt = Date.now();
  let invocation: Awaited<ReturnType<typeof openE2EInvocation>> | undefined;
  try {
    invocation = await openE2EInvocation({
      resources: ['homeserver'],
      workspaceRoot,
      environment,
      signal: termination.signal,
    });
    const homeserver = invocation.descriptor.homeserver;
    if (!homeserver?.available || !homeserver.hs) {
      throw new Error('The engine contract needs a running homeserver');
    }
    if (homeserver.kind !== 'synapse') {
      throw new Error(
        'The engine contract needs Synapse: set TRINITY_E2E_HOMESERVER=synapse',
      );
    }
    // The registry's artifact root: CI uploads the reports, and an aggregate reads the summary.
    const summaryFile = suiteSummaryPath(
      workspaceRoot,
      'trinity-e2e-engine',
      invocation.descriptor.id,
      'engine.js-sdk',
    );
    const reports = dirname(summaryFile);
    mkdirSync(reports, { recursive: true });
    // The session environment already relaxes TLS for the disposable local server.
    const contractEnvironment: NodeJS.ProcessEnv = {
      ...invocation.environment,
      TRINITY_ENGINE_CONTRACT_HS: homeserver.hs,
      TRINITY_ENGINE_CONTRACT_SERVER_NAME: SERVER_NAME,
      TRINITY_ENGINE_CONTRACT_DOMAIN: new URL(homeserver.hs).host,
      TRINITY_ENGINE_CONTRACT_SHARED_SECRET: REGISTRATION_SHARED_SECRET,
      // The mail cases (password reset, registration by email, adding an address) read
      // Synapse's mail from Mailpit.
      ...(homeserver.unavailable?.includes('mail')
        ? {}
        : { TRINITY_ENGINE_CONTRACT_MAILPIT: MAILPIT_HTTP }),
      // The identity cases need Sydent, which mails its links through Mailpit.
      ...(homeserver.unavailable?.some((f) => f === 'mail' || f === 'identity')
        ? {}
        : { TRINITY_ENGINE_CONTRACT_IDENTITY: IDENTITY_SERVER_URL }),
    };
    let status = 0;
    let passed = 0;
    for (const project of LIBS) {
      const reportFile = join(reports, `${project}.json`);
      const result = await runManagedCommand(
        'pnpm',
        [
          'exec',
          'nx',
          'run',
          `${project}:test`,
          '--skip-nx-cache',
          '--',
          'synapse',
          '--reporter=default',
          '--reporter=json',
          `--outputFile.json=${reportFile}`,
          '--reporter=junit',
          `--outputFile.junit=${join(reports, `${project}.xml`)}`,
        ],
        {
          cwd: workspaceRoot,
          environment: contractEnvironment,
          timeout: 600_000,
          signal: termination.signal,
        },
      );
      if (result.status !== 0) status = result.status;
      let json: string | undefined;
      try {
        json = readFileSync(reportFile, 'utf8');
      } catch {
        json = undefined;
      }
      const verdict = evaluateVitestReport(project, json);
      console.info(`[engine-contract] ${verdict.message}`);
      if (verdict.ok) passed += 1;
      else status ||= 1;
    }
    const summary = wdioSuiteSummary({
      suiteId: 'engine.js-sdk',
      exitCode: status,
      durationMs: Date.now() - startedAt,
      result: { passed, failed: LIBS.length - passed, retries: 0 },
    });
    writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
    return status;
  } finally {
    termination.close();
    await invocation?.close();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runEngineContract();
  } catch (error) {
    console.error('[engine-contract] invocation failed:', error);
    process.exitCode = 1;
  }
}
