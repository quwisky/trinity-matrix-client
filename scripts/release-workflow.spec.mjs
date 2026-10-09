/** Release packaging must not ship a half-signed macOS app. */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
/** Every signing credential name, including Windows names that are not wired up yet. */
const SIGNING_SECRETS = [...SECRETS, 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'];
const signJob = () => workflow.jobs['sign-mac'];
const copyStep = () =>
  signJob().steps.find((step) => step.name === 'Copy the built shell');
const shellJob = () => workflow.jobs['desktop-shell'];

function signingStep() {
  const steps = signJob().steps;
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
  it('checks the secrets in the signing job before electron-builder runs', () => {
    const { steps, index, step } = signingStep();
    expect(index).toBeGreaterThanOrEqual(0);
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

describe('macOS signing isolation', () => {
  const workflows = readdirSync(resolve(root, '.github/workflows')).filter(
    (name) => /\.ya?ml$/.test(name),
  );
  const runs = (job) => job.steps.flatMap((step) => step.run ?? []);

  it('reads the signing secrets only in the macOS signing job', () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const name of workflows) {
      const { jobs } = parse(
        readFileSync(resolve(root, '.github/workflows', name), 'utf8'),
      );
      for (const [id, job] of Object.entries(jobs)) {
        if (name === 'release.yml' && id === 'sign-mac') continue;
        const text = JSON.stringify(job);
        for (const secret of SIGNING_SECRETS)
          expect(text, `${name} ${id}`).not.toContain(`secrets.${secret}`);
      }
    }
  });

  it('passes the secrets to single steps, never to the whole job', () => {
    const job = signJob();
    expect(JSON.stringify(job.env ?? {})).not.toContain('secrets.');
    const reading = job.steps
      .filter((step) => JSON.stringify(step).includes('secrets.'))
      .map((step) => step.name);
    expect(reading).toEqual([
      'macOS signing secrets are complete',
      'electron-builder --mac',
    ]);
  });

  it('keeps the release environment, and its reviewers, on the signing job alone', () => {
    expect(signJob().environment).toBe('release');
    for (const name of workflows) {
      const { jobs } = parse(
        readFileSync(resolve(root, '.github/workflows', name), 'utf8'),
      );
      for (const [id, job] of Object.entries(jobs)) {
        if (name === 'release.yml' && id === 'sign-mac') continue;
        // An environment is a name or { name, url }.
        const environment = job.environment?.name ?? job.environment;
        expect(environment, `${name} ${id}`).not.toBe('release');
      }
    }
  });

  it('never hands a job every secret at once', () => {
    for (const name of workflows) {
      const text = readFileSync(
        resolve(root, '.github/workflows', name),
        'utf8',
      )
        .replace(/\s+/g, ' ')
        .toLowerCase();
      // Expression function names are case-insensitive, so toJson(secrets) counts too.
      for (const pattern of ['tojson(secrets)', 'secrets[', 'secrets: inherit'])
        expect(text, `${name} ${pattern}`).not.toContain(pattern);
    }
  });

  it('installs no dependency scripts and runs no workspace build next to the secrets', () => {
    const job = signJob();
    for (const step of job.steps) {
      expect(step.uses ?? '', step.name).not.toMatch(/^\.\//);
    }
    const commands = runs(job);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      if (/\bpnpm\b.*\b(?:install|i|add)\b/.test(command)) {
        expect(command).toContain('--ignore-scripts');
        expect(command).toContain('--frozen-lockfile');
      }
      expect(command).not.toMatch(
        /\bnx\b|scripts\/|\bpnpm (?:run|build|test|electron:)|\bnpx\b/,
      );
    }
    expect(commands).toContain(
      'pnpm -C electron install --frozen-lockfile --ignore-scripts',
    );
  });

  it('installs pnpm and Node from the pins the setup action uses', () => {
    const setup = parse(
      readFileSync(resolve(root, '.github/actions/setup/action.yml'), 'utf8'),
    ).runs.steps;
    for (const action of ['pnpm/action-setup@', 'actions/setup-node@']) {
      const pinned = setup.find((s) => s.uses?.startsWith(action)).uses;
      expect(signJob().steps.find((s) => s.uses?.startsWith(action)).uses).toBe(
        pinned,
      );
    }
  });

  it('signs the shell one Linux job built, without waiting for the package matrix', () => {
    const shell = shellJob();
    expect(shell['runs-on']).toBe('ubuntu-latest');
    expect(shell.needs).toBe('verify');
    expect(shell.steps.flatMap((s) => s.run ?? [])).toContain(
      'pnpm electron:build:release',
    );
    expect(JSON.stringify(shell)).not.toContain('secrets.');
    const upload = shell.steps.find((s) =>
      s.uses?.startsWith('actions/upload-artifact@'),
    );
    // Outside draft-release's trinity-* pattern: this is build input, not a release asset.
    expect(upload.with.name).not.toMatch(/^trinity-/);
    expect(upload.with.path.trim().split('\n')).toEqual([
      'electron/dist',
      'electron/www',
    ]);
    const platforms = workflow.jobs.package.strategy.matrix.include.map(
      (leg) => leg.platform,
    );
    expect(platforms).not.toContain('mac');

    const job = signJob();
    expect(job.needs).toEqual(['verify', 'desktop-shell']);
    expect(job.if).toBe(
      "${{ !cancelled() && needs.desktop-shell.result == 'success' }}",
    );
    const download = job.steps.find((s) =>
      s.uses?.startsWith('actions/download-artifact@'),
    );
    // Outside the checkout, so the artifact cannot land on electron-builder's config,
    // its afterPack hook or node_modules.
    expect(download.with).toEqual({
      name: upload.with.name,
      path: '${{ runner.temp }}/desktop-shell',
    });
    const steps = job.steps;
    const copy = steps.indexOf(copyStep());
    expect(copy).toBeGreaterThan(steps.indexOf(download));
    expect(copy).toBeLessThan(
      steps.findIndex((s) => s.name === 'electron-builder --mac'),
    );
    expect(copyStep().env.SHELL_DIR).toBe(download.with.path);
  });

  describe('copying the built shell into the checkout', () => {
    let work;
    beforeEach(() => {
      work = mkdtempSync(join(tmpdir(), 'desktop-shell-'));
      mkdirSync(join(work, 'artifact'));
      mkdirSync(join(work, 'checkout', 'electron'), { recursive: true });
    });
    afterEach(() => rmSync(work, { recursive: true, force: true }));

    const artifact = (path, text = 'x') => {
      mkdirSync(dirname(join(work, 'artifact', path)), { recursive: true });
      writeFileSync(join(work, 'artifact', path), text);
    };
    const copyShell = () =>
      spawnSync('bash', ['-e', '-c', copyStep().run], {
        cwd: join(work, 'checkout'),
        env: { PATH: process.env.PATH, SHELL_DIR: join(work, 'artifact') },
      }).status;
    const copied = (path) => existsSync(join(work, 'checkout/electron', path));

    it('copies dist and www', () => {
      artifact('dist/main.js');
      artifact('www/index.html');
      expect(copyShell()).toBe(0);
      expect(copied('dist/main.js')).toBe(true);
      expect(copied('www/index.html')).toBe(true);
    });

    it.each(['electron-builder.yml', 'afterPack.cjs', 'node_modules/x.js'])(
      'refuses an artifact that also carries %s',
      (extra) => {
        artifact('dist/main.js');
        artifact('www/index.html');
        artifact(extra);
        expect(copyShell()).not.toBe(0);
        expect(copied('dist')).toBe(false);
        expect(copied(extra)).toBe(false);
      },
    );

    it('refuses an artifact without both directories', () => {
      artifact('dist/main.js');
      expect(copyShell()).not.toBe(0);
      expect(copied('dist')).toBe(false);
    });

    it('refuses an artifact holding a symbolic link', () => {
      artifact('dist/main.js');
      artifact('www/index.html');
      symlinkSync('../../afterPack.cjs', join(work, 'artifact/www/hook.cjs'));
      expect(copyShell()).not.toBe(0);
      expect(copied('www')).toBe(false);
    });
  });

  it('packages and uploads the macOS installers under the name the draft collects', () => {
    const job = signJob();
    const builder = job.steps.find((s) => s.name === 'electron-builder --mac');
    expect(builder['working-directory']).toBe('electron');
    expect(builder.run).toBe(
      'pnpm exec electron-builder --mac --publish never',
    );
    expect(builder.env).toEqual({
      CSC_LINK: '${{ secrets.MAC_CSC_LINK }}',
      CSC_KEY_PASSWORD: '${{ secrets.MAC_CSC_KEY_PASSWORD }}',
      CSC_IDENTITY_AUTO_DISCOVERY: "${{ secrets.MAC_CSC_LINK != '' }}",
      APPLE_ID: '${{ secrets.APPLE_ID }}',
      APPLE_APP_SPECIFIC_PASSWORD: '${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}',
      APPLE_TEAM_ID: '${{ secrets.APPLE_TEAM_ID }}',
    });
    const upload = job.steps.find((s) =>
      s.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(upload.with.name).toBe('trinity-mac');
    expect(upload.with.path.trim().split('\n')).toEqual([
      'electron/release/*.dmg',
      'electron/release/*.zip',
    ]);
    expect(workflow.jobs['draft-release'].needs).toContain('sign-mac');
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

    it('installs the CLI from its own lockfile without install scripts', () => {
      const pnpm = steps().find((s) =>
        s.uses?.startsWith('pnpm/action-setup@'),
      );
      expect(pnpm.if).toBe(onReleaseBranch);
      const install = step('release-please-cli');
      expect(install.if).toBe("\${{ steps.version.outputs.version != '' }}");
      expect(install.run).toBe(
        'pnpm -C tools/release-please install --frozen-lockfile --ignore-scripts',
      );
      expect(at('release-please-cli')).toBeLessThan(at('first-release-pr'));
      const manifest = readJson('tools/release-please/package.json');
      expect(manifest.devDependencies['release-please']).toMatch(
        /^\d+\.\d+\.\d+$/,
      );
      expect(
        readFileSync(
          resolve(root, 'tools/release-please/pnpm-lock.yaml'),
          'utf8',
        ),
      ).toContain(
        `release-please@${manifest.devDependencies['release-please']}`,
      );
    });

    it('runs no unlocked package in any workflow', () => {
      const dir = resolve(root, '.github/workflows');
      for (const name of readdirSync(dir)) {
        expect(readFileSync(resolve(dir, name), 'utf8'), name).not.toMatch(
          /\bnpx\b|\bpnpm dlx\b/,
        );
      }
    });

    it('opens the release PR with the pinned CLI and --release-as when there is a version', () => {
      const cli = step('first-release-pr');
      expect(cli.if).toBe("\${{ steps.version.outputs.version != '' }}");
      expect(cli.env).toEqual({
        TOKEN: '\${{ steps.app-token.outputs.token }}',
        VERSION: '\${{ steps.version.outputs.version }}',
      });
      expect(
        cli.run
          .trim()
          .split(/\s+/)
          .filter((w) => w !== '\\'),
      ).toEqual([
        'pnpm',
        '-C',
        'tools/release-please',
        'exec',
        'release-please',
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
        'permission-contents': 'write',
        'permission-pull-requests': 'write',
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

  it('scopes each release App token to the permissions its job writes with', () => {
    // Pushes need contents, pull request edits and comments need pull-requests, and the
    // backport label the cut creates needs issues. Reads of this public repository need none.
    const scopes = {
      'release.yml release-please': ['contents', 'pull-requests'],
      'release.yml back-merge': ['contents', 'pull-requests'],
      'release.yml publish': ['contents'],
      'release-stable.yml cut': ['contents', 'issues'],
      'backport.yml backport': ['contents', 'pull-requests'],
      'land-back-merge.yml land': ['contents'],
    };
    for (const name of Object.keys(scopes).map((key) => key.split(' ')[0])) {
      const { jobs } = parse(
        readFileSync(resolve(root, '.github/workflows', name), 'utf8'),
      );
      for (const [id, job] of Object.entries(jobs)) {
        const mint = job.steps?.find((s) =>
          s.uses?.startsWith('actions/create-github-app-token@'),
        );
        if (!mint) continue;
        const requested = Object.entries(mint.with)
          .filter(([key]) => key.startsWith('permission-'))
          .map(([key, value]) => `${key.slice('permission-'.length)}:${value}`);
        expect(requested, `${name} ${id}`).toEqual(
          scopes[`${name} ${id}`].map((scope) => `${scope}:write`),
        );
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

describe('release-please token', () => {
  const job = () => workflow.jobs['release-please'];

  it('opens release PRs and creates tags with the release App, not the workflow token', () => {
    const mint = job().steps[0];
    expect(mint.id).toBe('app-token');
    expect(mint.uses).toMatch(
      /^actions\/create-github-app-token@[0-9a-f]{40}$/,
    );
    expect(mint.with['client-id']).toBe('${{ vars.RELEASE_APP_CLIENT_ID }}');
    expect(job().environment).toBe('release-app');
    const action = job().steps.find((s) => s.id === 'release');
    expect(action.with.token).toBe('${{ steps.app-token.outputs.token }}');
    expect(job().steps.find((s) => s.id === 'first-release-pr').env.TOKEN).toBe(
      '${{ steps.app-token.outputs.token }}',
    );
    expect(JSON.stringify(job())).not.toContain('github.token');
  });

  it('gives the workflow token no write access in that job', () => {
    expect(job().permissions).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('creates and moves no tag from any workflow script', () => {
    // Tags come only from release-please's createRelease, with the release App token.
    const dir = resolve(root, '.github/workflows');
    for (const name of readdirSync(dir)) {
      const { jobs } = parse(readFileSync(resolve(dir, name), 'utf8'));
      for (const [id, job] of Object.entries(jobs)) {
        for (const script of (job.steps ?? []).flatMap((s) => s.run ?? [])) {
          // One logical command per line: join backslash continuations.
          const run = script.replace(/\\\n/g, ' ');
          expect(run, `${name} ${id}`).not.toMatch(/\bgit\s+tag\b/);
          expect(run, `${name} ${id}`).not.toMatch(
            /\bgit\s+push\b[^\n]*(?:--tags|--follow-tags|refs\/tags)/,
          );
          // gh release create makes a missing tag unless --verify-tag forbids it.
          for (const create of run.match(/gh release create[^\n]*/g) ?? [])
            expect(create, `${name} ${id}`).toContain('--verify-tag');
        }
      }
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
