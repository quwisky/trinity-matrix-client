#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openE2EInvocation } from '../support/invocation.mts';
import {
  createProcessTerminationScope,
  runManagedCommand,
} from '../support/managed-command.mts';
import {
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
] as const;

export async function runEngineContract(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const termination = createProcessTerminationScope();
  let reports: string | undefined;
  let invocation: Awaited<ReturnType<typeof openE2EInvocation>> | undefined;
  try {
    reports = mkdtempSync(join(tmpdir(), 'trinity-engine-contract-'));
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
    // The session environment already relaxes TLS for the disposable local server.
    const contractEnvironment: NodeJS.ProcessEnv = {
      ...invocation.environment,
      TRINITY_ENGINE_CONTRACT_HS: homeserver.hs,
      TRINITY_ENGINE_CONTRACT_SERVER_NAME: SERVER_NAME,
      TRINITY_ENGINE_CONTRACT_DOMAIN: new URL(homeserver.hs).host,
      TRINITY_ENGINE_CONTRACT_SHARED_SECRET: REGISTRATION_SHARED_SECRET,
    };
    let status = 0;
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
      if (!verdict.ok) status ||= 1;
    }
    return status;
  } finally {
    termination.close();
    await invocation?.close();
    if (reports) rmSync(reports, { recursive: true, force: true });
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
