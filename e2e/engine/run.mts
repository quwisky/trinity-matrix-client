#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  REGISTRATION_SHARED_SECRET,
  start,
} from '../support/homeserver/start.mjs';
import { stop } from '../support/homeserver/stop.mjs';
import {
  acquireHomeserverLease,
  releaseHomeserverLease,
} from '../support/homeserver/lease.mts';

const LIBS = ['data-access-homeserver', 'data-access-discovery'] as const;

interface VitestReport {
  readonly numPassedTests: number;
  readonly numFailedTests: number;
  readonly numPendingTests: number;
}

function runLib(
  project: string,
  reportFile: string,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
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
      { stdio: 'inherit', env: environment },
    );
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

export async function runEngineContract(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const reports = mkdtempSync(join(tmpdir(), 'trinity-engine-contract-'));
  const lease = await acquireHomeserverLease();
  try {
    // The harness probes Caddy before its local CA is trusted; invocation.mts does the same.
    const previousTlsPolicy = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    let harness: Awaited<ReturnType<typeof start>>;
    try {
      harness = await start();
    } finally {
      if (previousTlsPolicy === undefined)
        delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previousTlsPolicy;
    }
    if (!harness.caddyRoot) {
      throw new Error('The native runtime did not report Caddy root.crt');
    }
    const contractEnvironment: NodeJS.ProcessEnv = {
      ...environment,
      NODE_EXTRA_CA_CERTS: harness.caddyRoot,
      TRINITY_ENGINE_CONTRACT_HS: harness.hs,
      TRINITY_ENGINE_CONTRACT_SERVER_NAME: harness.serverName,
      TRINITY_ENGINE_CONTRACT_DOMAIN: new URL(harness.hs).host,
      TRINITY_ENGINE_CONTRACT_SHARED_SECRET: REGISTRATION_SHARED_SECRET,
    };
    let status = 0;
    for (const project of LIBS) {
      const reportFile = join(reports, `${project}.json`);
      const code = await runLib(project, reportFile, contractEnvironment);
      if (code !== 0) status = code;
      let report: VitestReport;
      try {
        report = JSON.parse(readFileSync(reportFile, 'utf8')) as VitestReport;
      } catch {
        console.error(`[engine-contract] ${project}: no test report written`);
        status ||= 1;
        continue;
      }
      console.info(
        `[engine-contract] ${project}: ${report.numPassedTests} passed, ${report.numFailedTests} failed, ${report.numPendingTests} skipped`,
      );
      // A skipped or absent synapse spec must never read as a pass.
      if (report.numPassedTests === 0 || report.numPendingTests > 0) {
        console.error(`[engine-contract] ${project}: gated specs did not run`);
        status ||= 1;
      }
    }
    return status;
  } finally {
    try {
      await stop();
    } finally {
      releaseHomeserverLease(lease);
      rmSync(reports, { recursive: true, force: true });
    }
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
