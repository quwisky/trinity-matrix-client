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

  describe('first stable release on a release branch', () => {
    const steps = () => workflow.jobs['release-please'].steps;
    const step = (id) => steps().find((s) => s.id === id);
    const at = (id) => steps().findIndex((s) => s.id === id);
    const onReleaseBranch = `\${{ ${ref} }}`;

    it('finds the version from the tags, only on release branches', () => {
      const checkout = steps().find((s) =>
        s.uses?.startsWith('actions/checkout@'),
      );
      expect(checkout.if).toBe(onReleaseBranch);
      // Every tag and the whole history: the helper reads the tags reachable from HEAD.
      expect(checkout.with).toMatchObject({
        'fetch-depth': 0,
        'persist-credentials': false,
      });
      const node = steps().find((s) =>
        s.uses?.startsWith('actions/setup-node@'),
      );
      expect(node.if).toBe(onReleaseBranch);
      expect(node.with['node-version-file']).toBe('.nvmrc');
      const version = step('version');
      expect(version.if).toBe(onReleaseBranch);
      expect(version.env.BRANCH).toBe('\${{ github.ref_name }}');
      // A failing helper must fail the job, not fall back to a patch release PR.
      expect(version.run.split('\n')).toEqual([
        'version=$(node scripts/release-version.mjs "$BRANCH")',
        'echo "version=$version" | tee -a "$GITHUB_OUTPUT"',
        '',
      ]);
      expect(at('version')).toBeLessThan(at('first-release-pr'));
    });

    it('opens the release PR with the pinned CLI and --release-as when there is a version', () => {
      const cli = step('first-release-pr');
      expect(cli.if).toBe("\${{ steps.version.outputs.version != '' }}");
      expect(cli.env).toEqual({
        TOKEN: '\${{ github.token }}',
        VERSION: '\${{ steps.version.outputs.version }}',
      });
      expect(
        cli.run
          .trim()
          .split(/\s+/)
          .filter((w) => w !== '\\'),
      ).toEqual([
        'npx',
        '--yes',
        'release-please@17.11.2',
        'release-pr',
        '--token',
        '"$TOKEN"',
        '--repo-url',
        '"$GITHUB_REPOSITORY"',
        '--target-branch',
        '"$GITHUB_REF_NAME"',
        '--config-file',
        'release-please-config.json',
        '--manifest-file',
        '.release-please-manifest.json',
        '--release-as',
        '"$VERSION"',
      ]);
      expect(at('first-release-pr')).toBeLessThan(at('release'));
    });

    it('lets the action only tag and release when the CLI ran', () => {
      const action = releasePlease();
      expect(action.if).toBeUndefined();
      expect(action.with['skip-github-pull-request']).toBe(
        "\${{ steps.version.outputs.version != '' }}",
      );
      expect(workflow.jobs['release-please'].outputs).toEqual({
        created: '\${{ steps.release.outputs.release_created }}',
        tag: '\${{ steps.release.outputs.tag_name }}',
      });
    });
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

    it('runs in the release-app environment that holds the release App key', () => {
      expect(job().environment).toBe('release-app');
    });

    it('mints the pinned App token and runs the script with it', () => {
      const mint = job().steps.find((s) => s.id === 'app-token');
      expect(mint.with).toEqual({
        'client-id': '\${{ vars.RELEASE_APP_CLIENT_ID }}',
        'private-key': '\${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
      });
      expect(mint.uses).toMatch(
        /^actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1$/,
      );
      const run = job().steps.find((s) => s.run?.includes('back-merge.mjs'));
      expect(run.run).toContain(
        'node scripts/back-merge.mjs --tag "$TAG" --branch "$BRANCH"',
      );
      expect(run.env.GH_TOKEN).toBe('\${{ steps.app-token.outputs.token }}');
    });

    it('never pushes to the release branch: it only opens the back-merge PR', () => {
      const steps = job().steps;
      const runs = steps.map((s) => s.run ?? '').join('\n');
      expect(runs).not.toContain('release-as');
      expect(runs).not.toContain('refs/heads/$BRANCH');
      expect(runs).not.toMatch(/git (push|commit)/);
      const run = steps.find((s) => s.run?.includes('back-merge.mjs'));
      expect(run.run).toContain('trinity-release[bot]');
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

  it('mints the release App token only in the reviewer-free release-app environment', () => {
    // Required reviewers on `release` gate packaging; they must not stall the automation.
    for (const name of [
      'release.yml',
      'release-stable.yml',
      'backport.yml',
      'land-back-merge.yml',
    ]) {
      const { jobs } = parse(
        readFileSync(resolve(root, '.github/workflows', name), 'utf8'),
      );
      const minting = Object.entries(jobs).filter(([, job]) =>
        job.steps?.some((s) =>
          s.uses?.startsWith('actions/create-github-app-token@'),
        ),
      );
      expect(minting.length, name).toBeGreaterThan(0);
      for (const [id, job] of minting) {
        expect(job.environment, `${name} ${id}`).toBe('release-app');
      }
    }
  });

  it('does not use the Renovate App in any release workflow', () => {
    for (const name of ['release.yml', 'release-stable.yml']) {
      expect(
        readFileSync(resolve(root, '.github/workflows', name), 'utf8'),
      ).not.toContain('RENOVATE_APP');
    }
  });
});

describe('release publishing job', () => {
  const job = workflow.jobs.publish;

  it('waits for the draft and reads the tag from verify', () => {
    expect(job.needs).toEqual(
      expect.arrayContaining(['verify', 'draft-release']),
    );
    expect(job.environment).toBe('release-app');
  });

  it('mints the release App token and runs the script after Node setup', () => {
    const { steps } = job;
    const token = steps.find((s) =>
      s.uses?.startsWith('actions/create-github-app-token@'),
    );
    expect(token.with['client-id']).toBe('\${{ vars.RELEASE_APP_CLIENT_ID }}');
    expect(token.with['private-key']).toBe(
      '\${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
    );
    const node = steps.findIndex((s) =>
      s.uses?.startsWith('actions/setup-node@'),
    );
    const run = steps.findIndex((s) =>
      s.run?.includes('scripts/release-publish.mjs'),
    );
    expect(node).toBeGreaterThanOrEqual(0);
    expect(node).toBeLessThan(run);
    expect(steps[run].env.GH_TOKEN).toBe(
      '\${{ steps.app-token.outputs.token }}',
    );
  });
});
