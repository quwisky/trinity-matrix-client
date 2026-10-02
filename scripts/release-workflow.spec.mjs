/** Release packaging must not ship a half-signed macOS app. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const workflow = parse(
  readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8'),
);
const SECRETS = [
  'MAC_CSC_LINK',
  'MAC_CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];

function signingStep() {
  const steps = workflow.jobs.package.steps;
  const index = steps.findIndex(
    (step) => step.name === 'macOS signing secrets are complete',
  );
  return { steps, index, step: steps[index] };
}

function runWith(names) {
  const env = { PATH: process.env.PATH };
  for (const name of names) env[name] = 'set';
  return spawnSync('bash', ['-e', '-c', signingStep().step.run], { env })
    .status;
}

describe('release macOS signing', () => {
  it('checks the secrets on the mac leg before electron-builder runs', () => {
    const { steps, index, step } = signingStep();
    expect(index).toBeGreaterThanOrEqual(0);
    expect(step.if).toBe("matrix.platform == 'mac'");
    const builder = steps.findIndex((s) =>
      s.name?.startsWith('electron-builder'),
    );
    expect(index).toBeLessThan(builder);
    for (const name of SECRETS) {
      expect(step.env[name]).toBe(`\${{ secrets.${name} }}`);
    }
  });

  it('passes with none or all of the secrets and fails with some', () => {
    expect(runWith([])).toBe(0);
    expect(runWith(SECRETS)).toBe(0);
    expect(runWith(['MAC_CSC_LINK'])).not.toBe(0);
    expect(runWith(['APPLE_ID', 'APPLE_TEAM_ID'])).not.toBe(0);
    expect(runWith(SECRETS.slice(0, 4))).not.toBe(0);
  });
});
