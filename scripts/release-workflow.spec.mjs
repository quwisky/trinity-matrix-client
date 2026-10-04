/** Release packaging must not ship a half-signed macOS app. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const workflow = parse(
  readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8'),
);
const readJson = (name) =>
  JSON.parse(readFileSync(resolve(root, name), 'utf8'));
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

describe('release branches', () => {
  const ref = "startsWith(github.ref_name, 'release/')";
  const releasePlease = () =>
    workflow.jobs['release-please'].steps.find((s) => s.id === 'release');

  it('runs on main and release/** pushes', () => {
    expect(workflow.on.push.branches).toEqual(['main', 'release/**']);
  });

  it('picks the release-please config and manifest by branch', () => {
    const { with: w } = releasePlease();
    expect(w['config-file']).toBe(
      `\${{ ${ref} && 'release-please-config.json' || 'release-please-config.next.json' }}`,
    );
    expect(w['manifest-file']).toBe(
      `\${{ ${ref} && '.release-please-manifest.json' || '.release-please-manifest.next.json' }}`,
    );
  });

  it('requires the tagged commit on main or a release branch', () => {
    const run = workflow.jobs.verify.steps.find((s) =>
      s.name?.startsWith('Tagged commit'),
    ).run;
    expect(run).toContain('origin/main');
    expect(run).toContain('refs/remotes/origin/release/');
    expect(run).not.toContain('origin/develop');
  });

  it('configures versioning per line', () => {
    expect(readJson('release-please-config.json').versioning).toBe(
      'always-bump-patch',
    );
    expect(readJson('release-please-config.next.json').versioning).toBe(
      'prerelease',
    );
  });

  describe('back-merge job', () => {
    const job = () => workflow.jobs['back-merge'];

    it('runs only after a release-please release on a release branch', () => {
      expect(job().needs).toContain('release-please');
      expect(job().needs).not.toContain('verify');
      expect(job().needs).not.toContain('package');
      expect(job().if).toBe(
        `\${{ needs.release-please.outputs.created == 'true' && ${ref} }}`,
      );
    });

    it('mints the pinned App token and runs the script with it', () => {
      const mint = job().steps.find((s) => s.id === 'app-token');
      expect(mint.uses).toMatch(
        /^actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1$/,
      );
      const run = job().steps.find((s) => s.run?.includes('back-merge.mjs'));
      expect(run.run).toContain(
        'node scripts/back-merge.mjs --tag "$TAG" --branch "$BRANCH"',
      );
      expect(run.env.GH_TOKEN).toBe('\${{ steps.app-token.outputs.token }}');
    });

    it('sets up Node before running the script', () => {
      const steps = job().steps;
      const node = steps.findIndex((s) =>
        s.uses?.startsWith('actions/setup-node@'),
      );
      const run = steps.findIndex((s) => s.run?.includes('back-merge.mjs'));
      expect(node).toBeGreaterThanOrEqual(0);
      expect(node).toBeLessThan(run);
      expect(steps[node].with['node-version-file']).toBe('.nvmrc');
    });
  });
});
