#!/usr/bin/env node
/** The registry owns suite policy; this adapter binds it to one immutable CI checkout. */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_SUITES, E2E_TIMEOUTS_MS } from '../e2e/registry/index.mts';
import { createProcessTerminationScope } from '../e2e/support/managed-command.mts';
import { runPrerequisites } from './ci-prerequisites.mjs';
import { isDirectRun, resultExitCode, runCommand } from './ci-run-command.mjs';
import { runSuite } from './e2e-suite-registry.mjs';
import { validateCoordinates as validateRendererCoordinates } from './renderer-artifact.mjs';
import {
  currentCommit,
  readWebBundleManifest,
  verifyWebBundleRoot,
} from './web-bundle-manifest.mjs';

const ROOT = join(import.meta.dirname, '..');
const RENDERER_KEYS = [
  'CI_RENDERER_SOURCE_RUN_ID',
  'CI_RENDERER_ARTIFACT_ID',
  'CI_RENDERER_ARTIFACT_NAME',
  'CI_RENDERER_MANIFEST_DIGEST',
];

export function suiteForId(suiteId) {
  const suite = E2E_SUITES.find(({ id }) => id === suiteId);
  if (!suite?.ciPreparation || suite.ciTier !== 'pull-request') {
    throw new Error(`Unknown reusable browser CI suite: ${suiteId}`);
  }
  return suite;
}

export function validateCoordinates(suite, environment = process.env) {
  const sha = environment.CI_E2E_SHA;
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || sha !== currentCommit()) {
    throw new Error('CI_E2E_SHA must match the exact full checkout SHA');
  }
  const requiresRenderer =
    suite.ciPreparation.renderer === 'verified-production';
  const values = RENDERER_KEYS.map((key) => environment[key]);
  const count = values.filter(
    (value) => value !== undefined && value !== '',
  ).length;
  if (requiresRenderer) {
    if (count !== RENDERER_KEYS.length) {
      throw new Error(
        'Production renderer requires all verified renderer coordinates',
      );
    }
    validateRendererCoordinates({
      sha,
      runId: values[0],
      artifactId: values[1],
      artifactName: values[2],
      digest: values[3],
    });
  } else if (count !== 0) {
    throw new Error(`${suite.id} does not accept renderer coordinates`);
  }
  return { sha, requiresRenderer };
}

export function plan(suiteId, environment = process.env) {
  const suite = suiteForId(suiteId);
  const coordinates = validateCoordinates(suite, environment);
  return {
    suiteId: suite.id,
    browsers: suite.prerequisites
      .filter((requirement) => requirement.startsWith('playwright-'))
      .map((requirement) => requirement.slice('playwright-'.length)),
    reportPath: `${suite.targetArtifactRoot.replace('<run-id>', '*')}/${suite.id}/**`,
    requiresRenderer: coordinates.requiresRenderer,
    buildTarget: suite.ciPreparation.buildTarget ?? null,
    currentTarget: suite.currentTarget,
    timeoutMs: E2E_TIMEOUTS_MS[suite.timeoutClass],
  };
}

export async function prepare(
  suiteId,
  { environment = process.env, ...options } = {},
) {
  const suite = suiteForId(suiteId);
  const details = plan(suiteId, environment);
  return runPrerequisites({
    ...options,
    browsers: details.browsers,
    includeDocker: suite.prerequisites.includes('docker'),
    buildTarget: details.buildTarget,
  });
}

export async function run(
  suiteId,
  { environment = process.env, execute = runCommand, signal } = {},
) {
  const suite = suiteForId(suiteId);
  const details = plan(suiteId, environment);
  if (details.requiresRenderer) {
    if (environment.TRINITY_E2E_PREBUILT_WWW !== '1') {
      throw new Error(
        'Restore the verified production renderer before running its suite',
      );
    }
    const manifest = readWebBundleManifest(
      join(ROOT, 'dist/web-bundle-manifest.json'),
      environment.CI_RENDERER_MANIFEST_DIGEST,
    );
    verifyWebBundleRoot(join(ROOT, 'www'), manifest, {
      expectedSha: environment.CI_E2E_SHA,
    });
  }
  return runSuite(suite, {
    environment,
    signal,
    forwardedArgs: ['--fail-on-flaky-tests'],
    execute: async (command, args, options) => {
      const probeTimeoutMs = Number(environment.PROBE_582_TIMEOUT_MS);
      const timeoutMs =
        suite.id === 'components.storybook' &&
        Number.isFinite(probeTimeoutMs) &&
        probeTimeoutMs > 0
          ? probeTimeoutMs
          : options.timeout;
      if (timeoutMs !== options.timeout)
        console.error(
          `[probe] deliberate ${suite.id} timeout: ${timeoutMs} ms`,
        );
      const result = await execute({
        command,
        args,
        cwd: options.cwd,
        env: options.environment,
        timeoutMs,
        abortSignal: options.signal,
        killGraceMs: 60_000,
        label: `suite-${suite.id}`,
        logDir: join(ROOT, 'dist/.ci'),
      });
      return { status: resultExitCode(result), timedOut: result.timedOut };
    },
  });
}

async function main() {
  const command = process.argv[2];
  const suiteId = process.env.CI_E2E_SUITE;
  if (
    process.argv.length !== 3 ||
    !suiteId ||
    !['plan', 'prepare', 'run'].includes(command)
  ) {
    throw new Error(
      'usage: CI_E2E_SUITE=<registered-suite> ci-e2e-suite.mjs <plan|prepare|run>',
    );
  }
  if (command === 'plan') {
    const details = plan(suiteId);
    if (process.env.GITHUB_OUTPUT) {
      for (const [key, value] of Object.entries({
        'suite-id': details.suiteId,
        browsers: details.browsers.join(' '),
        'report-path': details.reportPath,
        'requires-renderer': String(details.requiresRenderer),
      }))
        appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
    console.log(JSON.stringify(details));
    return;
  }
  const termination = createProcessTerminationScope();
  try {
    const result =
      command === 'prepare'
        ? await prepare(suiteId, { abortSignal: termination.signal })
        : await run(suiteId, { signal: termination.signal });
    process.exitCode = termination.signal.aborted
      ? 143
      : (result.exitCode ?? result);
  } finally {
    termination.close();
  }
}

if (isDirectRun(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
