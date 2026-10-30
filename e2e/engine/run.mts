#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
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
export const LIBS = [
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
  'data-access-identity',
] as const;
/** The libraries whose contract also runs against the Rust engine, as `*.rust.spec.ts`. */
export const RUST_LIBS = ['data-access-homeserver'] as const;

export type ContractEngine = 'js-sdk' | 'rust';

/** The suite id, its summary file and one test command per library for `engine`. */
export function buildContractCommand(
  engine: ContractEngine,
  runId: string,
): {
  suiteId: string;
  summaryFile: string;
  runs: { project: string; reportFile: string; args: string[] }[];
} {
  const suiteId = `engine.${engine}`;
  // The registry's artifact root: CI uploads the reports, and an aggregate reads the summary.
  const summaryFile = suiteSummaryPath(
    workspaceRoot,
    'trinity-e2e-engine',
    runId,
    suiteId,
  );
  const reports = dirname(summaryFile);
  // `.rust.spec`, not `rust`: "trust" contains "rust".
  const filter = engine === 'rust' ? '.rust.spec' : 'synapse';
  const libs = engine === 'rust' ? RUST_LIBS : LIBS;
  const runs = libs.map((project) => {
    const reportFile = join(reports, `${project}.json`);
    return {
      project,
      reportFile,
      args: [
        'exec',
        'nx',
        'run',
        `${project}:test`,
        '--skip-nx-cache',
        '--',
        filter,
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${reportFile}`,
        '--reporter=junit',
        `--outputFile.junit=${join(reports, `${project}.xml`)}`,
      ],
    };
  });
  return { suiteId, summaryFile, runs };
}

export async function runEngineContract(
  environment: NodeJS.ProcessEnv = process.env,
  engine: ContractEngine = 'js-sdk',
): Promise<number> {
  const termination = createProcessTerminationScope();
  const startedAt = Date.now();
  let invocation: Awaited<ReturnType<typeof openE2EInvocation>> | undefined;
  try {
    // Built before the homeserver starts, so a compile error fails fast.
    const testhost =
      engine === 'rust'
        ? await buildTesthost(environment, termination.signal)
        : {};
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
    const { suiteId, summaryFile, runs } = buildContractCommand(
      engine,
      invocation.descriptor.id,
    );
    mkdirSync(dirname(summaryFile), { recursive: true });
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
      ...testhost,
    };
    let status = 0;
    let passed = 0;
    for (const { project, reportFile, args } of runs) {
      const result = await runManagedCommand('pnpm', args, {
        cwd: workspaceRoot,
        environment: contractEnvironment,
        timeout: 600_000,
        signal: termination.signal,
      });
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
      suiteId,
      exitCode: status,
      durationMs: Date.now() - startedAt,
      result: { passed, failed: runs.length - passed, retries: 0 },
    });
    writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
    return status;
  } finally {
    termination.close();
    await invocation?.close();
  }
}

/** Builds the stdio test host and returns the environment its contract specs read. */
async function buildTesthost(
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
  const build = await runManagedCommand(
    'cargo',
    ['build', '-p', 'trinity-engine-testhost', '--locked'],
    { cwd: workspaceRoot, environment, timeout: 1_200_000, signal },
  );
  if (build.status !== 0) {
    throw new Error('cargo build -p trinity-engine-testhost failed');
  }
  return {
    TRINITY_ENGINE_TESTHOST: resolve(
      workspaceRoot,
      environment['CARGO_TARGET_DIR'] ?? 'target',
      'debug/trinity-engine-testhost',
    ),
    // The test host's half of the TLS relaxation the session environment gives Node.
    TRINITY_ENGINE_INSECURE_TLS: '1',
  };
}

/** The `--engine` in `args`, ignoring the args `pnpm e2e:protocol -- <args>` forwards. */
export function contractEngine(args: string[]): ContractEngine {
  const { values } = parseArgs({
    args,
    strict: false,
    options: { engine: { type: 'string', default: 'js-sdk' } },
  });
  if (values.engine !== 'js-sdk' && values.engine !== 'rust') {
    throw new Error(`--engine must be js-sdk or rust, not ${values.engine}`);
  }
  return values.engine;
}

if (import.meta.main) {
  try {
    process.exitCode = await runEngineContract(
      process.env,
      contractEngine(process.argv.slice(2)),
    );
  } catch (error) {
    console.error('[engine-contract] invocation failed:', error);
    process.exitCode = 1;
  }
}
