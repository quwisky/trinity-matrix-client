import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, resultExitCode, isDirectRun } from './ci-run-command.mjs';
import { validateReports } from './ci-diagnostics.mjs';

const ROOT = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const SCENARIOS = ['always-fail', 'retry', 'soft-timeout', 'missing-report'];

/** Check the actual Playwright outcome, independently of the wrapper's exit status. */
export function assessProof({
  scenario,
  exitCode,
  status,
  hasReports,
  started,
}) {
  const errors = [];
  if (!SCENARIOS.includes(scenario)) return ['unknown proof scenario'];
  if (scenario === 'missing-report') {
    if (exitCode !== 0 || status !== 'expected')
      errors.push('passing fixture did not pass');
    if (hasReports) errors.push('missing report root was accepted');
  } else {
    if (exitCode === 0) errors.push('failed or flaky fixture returned success');
    if (!hasReports) errors.push('diagnostics were not retained');
    if (scenario === 'retry' && status !== 'flaky')
      errors.push('retry did not pass after failing');
    if (scenario === 'always-fail' && status !== 'unexpected')
      errors.push('fixture did not fail as intended');
    if (
      scenario === 'soft-timeout' &&
      (exitCode !== 124 || status !== 'interrupted' || !started)
    ) {
      errors.push('wrapper did not interrupt an active Playwright test');
    }
  }
  return errors;
}

/** Explicit real-browser proof; never called by the docs/source-contract test target. */
export async function runProofScenario(scenario) {
  if (!SCENARIOS.includes(scenario)) throw new Error('unknown proof scenario');
  const id = `proof.${scenario}.${randomUUID()}`;
  const fixtureDir = join(ROOT, 'dist', '.ci-proof', id);
  mkdirSync(fixtureDir, { recursive: true });
  const marker = join(fixtureDir, 'running.marker');
  const jsonFile = join(fixtureDir, 'results.json');
  const configFile = join(fixtureDir, 'playwright.config.mjs');
  const testImport = require.resolve('@playwright/test');
  const body =
    scenario === 'soft-timeout'
      ? `writeFileSync(${JSON.stringify(marker)}, 'running'); await new Promise(() => {});`
      : scenario === 'retry'
        ? `if (testInfo.retry === 0) expect('first attempt').toBe('retry attempt');`
        : scenario === 'always-fail'
          ? `expect('failure').toBe('passing');`
          : '';
  writeFileSync(
    join(fixtureDir, 'proof.spec.mjs'),
    `
import playwrightTest from ${JSON.stringify(testImport)};
import { writeFileSync } from 'node:fs';
const { test, expect } = playwrightTest;
test('CI diagnostics proof: ${scenario}', async ({ page }, testInfo) => {
  await page.setContent('<main>diagnostics proof</main>');
  ${body}
});
`,
  );
  writeFileSync(
    configFile,
    `
import { e2eLifecycleConfig } from ${JSON.stringify(join(ROOT, 'e2e/support/playwright-config.mts'))};
const config = e2eLifecycleConfig({
  suite: { id: ${JSON.stringify(id)}, targetProject: 'ci-proof', environment: 'components',
    capabilities: ['design-system'], contractTypes: ['behavior'], prerequisites: ['playwright-chromium'],
    availabilityPolicy: 'required', ciTier: 'local-only' },
  projectRoot: ${JSON.stringify(fixtureDir)}, testDir: ${JSON.stringify(fixtureDir)},
  endpoint: 'application', timeout: 120000,
});
export default { ...config, reporter: [...config.reporter, ['json', { outputFile: ${JSON.stringify(jsonFile)} }]] };
`,
  );
  const result = await runCommand({
    command: 'pnpm',
    args: [
      'exec',
      'nx',
      'exec',
      '--projects=trinity-e2e-support',
      '--',
      'node',
      join(ROOT, 'e2e/support/run-playwright.mts'),
      `--config=${configFile}`,
    ],
    cwd: ROOT,
    env: { CI: 'true' },
    label: `proof-${scenario}`,
    timeoutMs: scenario === 'soft-timeout' ? 20000 : 180000,
    killGraceMs: 60000,
  });
  const reportPath = `dist/.playwright/ci-proof/*/${scenario === 'missing-report' ? `${id}.missing` : id}/**`;
  let files = [];
  try {
    files = validateReports({ root: ROOT, reportPath });
  } catch {
    /* Assessed below. */
  }
  const json = existsSync(jsonFile)
    ? JSON.parse(readFileSync(jsonFile, 'utf8'))
    : undefined;
  const test = json?.suites?.[0]?.specs?.[0]?.tests?.[0];
  const status = test?.results?.some(
    (attempt) => attempt.status === 'interrupted',
  )
    ? 'interrupted'
    : test?.status;
  const exitCode = resultExitCode(result);
  const errors = assessProof({
    scenario,
    exitCode,
    status,
    hasReports: files.length > 0,
    started: existsSync(marker),
  });
  const summary = {
    scenario,
    exitCode,
    status,
    verified: errors.length === 0,
    errors,
    reportPath,
    files,
  };
  const evidenceDir = join(
    ROOT,
    'dist/.playwright/ci-proof/evidence',
    scenario,
  );
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, 'proof-summary.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (isDirectRun(import.meta.url)) {
  const result = await runProofScenario(process.argv[2]);
  process.exitCode =
    result.verified && result.scenario !== 'missing-report'
      ? result.exitCode
      : 1;
}
