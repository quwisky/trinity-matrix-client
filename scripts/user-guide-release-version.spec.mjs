/** Stable release PRs carry the user guide to the new version; prereleases leave it alone. */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { workflow as loadWorkflow } from './workspace-sources.mjs';

const root = resolve(import.meta.dirname, '..');
const readJson = (path) =>
  JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const docsDir = 'apps/docs-users/src/content/docs';
const pages = readdirSync(resolve(root, docsDir), { recursive: true })
  .filter((file) => /\.mdx?$/.test(file))
  .map((file) => join(docsDir, file));
// Same pattern release-please's generic updater replaces, once per line.
const semver = /\d+\.\d+\.\d+(-[\w.]+)?/g;

describe('user guide release version', () => {
  it('bumps the manifest and every page on stable release PRs', () => {
    const { 'extra-files': extraFiles } = readJson(
      'release-please-config.json',
    );
    expect(extraFiles).toContainEqual({
      type: 'json',
      path: 'apps/docs-users/release.json',
      jsonpath: '$.version',
    });
    expect(extraFiles).toContainEqual({
      type: 'generic',
      path: `${docsDir}/**/*.{md,mdx}`,
      glob: true,
    });
  });

  it('leaves the user guide on the stable version for prereleases', () => {
    const { 'extra-files': extraFiles } = readJson(
      'release-please-config.next.json',
    );
    expect(extraFiles.map((file) => file.path)).not.toContainEqual(
      expect.stringContaining('docs-users'),
    );
  });

  describe('documentation Pages workflow', () => {
    const workflow = loadWorkflow('docs-pages.yml');

    it('redeploys from main when a stable release is published', () => {
      expect(workflow.on.release.types).toEqual(['published']);
      const job = workflow.jobs.redeploy;
      expect(job.if).toBe(
        "github.event_name == 'release' && !github.event.release.prerelease",
      );
      expect(job.permissions).toEqual({ actions: 'write' });
      expect(job.steps.at(-1).run).toMatch(
        /^gh workflow run docs-pages.yml --ref main$/m,
      );
    });

    it('builds the user guide from its last published version and deploys main', () => {
      const { steps } = workflow.jobs.build;
      expect(steps[0].with).toEqual({ 'fetch-depth': 0 });
      const index = steps.findIndex((step) => step.id === 'release');
      const check = steps[index];
      expect(check.run).toContain(
        'gh api "repos/$GITHUB_REPOSITORY/releases/tags/v$version" --jq .draft',
      );
      expect(check.run).toContain('git checkout "$ref" -- apps/docs-users');
      // The checks before it still validate main's own user guide.
      expect(steps[index + 1].run).toBe('pnpm nx run docs-site:check');
      expect(workflow.jobs.build.outputs).toBeUndefined();
      expect(workflow.jobs.deploy.if).toBe("github.ref == 'refs/heads/main'");
    });

    /**
     * Runs the step in a repository whose user guide went 0.6.0 then 0.7.0, against a
     * `gh` that answers the release lookup per version. Returns the version left checked out.
     */
    function guideVersion(answers) {
      const dir = mkdtempSync(join(tmpdir(), 'docs-release-'));
      const git = (...args) =>
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
          { cwd: dir, stdio: 'ignore' },
        );
      const manifest = join(dir, 'apps/docs-users/release.json');
      try {
        git('init');
        // The guide is younger than the repository, as in Trinity.
        git('commit', '--allow-empty', '-m', 'root');
        mkdirSync(join(dir, 'apps/docs-users'), { recursive: true });
        for (const version of ['0.6.0', '0.7.0']) {
          writeFileSync(manifest, JSON.stringify({ version }));
          git('add', '.');
          git('commit', '-m', version);
        }
        const cases = Object.entries(answers)
          .map(([version, answer]) => `*/v${version}) ${answer};;`)
          .join(' ');
        writeFileSync(
          join(dir, 'gh'),
          `#!/bin/sh\ncase "$2" in ${cases} esac\n`,
          { mode: 0o755 },
        );
        const step = workflow.jobs.build.steps.find((s) => s.id === 'release');
        // Actions runs a `run:` step as `bash -e`.
        const { status } = spawnSync('bash', ['-e', '-c', step.run], {
          cwd: dir,
          env: {
            PATH: `${dir}:${process.env.PATH}`,
            GITHUB_REPOSITORY: 'owner/repo',
          },
          timeout: 5000,
        });
        return { status, version: JSON.parse(readFileSync(manifest)).version };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const published = 'echo false';
    // What a lookup by tag gets for a draft, which has no tag, and for a missing release.
    const hidden = 'echo "gh: Not Found (HTTP 404)" >&2; exit 1';

    it('keeps the guide of a published release', () => {
      expect(guideVersion({ '0.7.0': published })).toEqual({
        status: 0,
        version: '0.7.0',
      });
    });

    it('steps back to the last published release past an unpublished one', () => {
      expect(guideVersion({ '0.7.0': hidden, '0.6.0': published })).toEqual({
        status: 0,
        version: '0.6.0',
      });
      expect(
        guideVersion({ '0.7.0': 'echo true', '0.6.0': published }),
      ).toEqual({ status: 0, version: '0.6.0' });
    });

    it('fails when it cannot read a release, so an outdated guide is not deployed', () => {
      expect(
        guideVersion({
          '0.7.0': 'echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1',
          '0.6.0': published,
        }),
      ).toEqual({ status: 1, version: '0.7.0' });
    });

    it('keeps a published release whose lookup also wrote a warning', () => {
      expect(
        guideVersion({ '0.7.0': 'echo "a notice from gh" >&2; echo false' }),
      ).toEqual({ status: 0, version: '0.7.0' });
    });

    it('fails when no release in the guide history is published', () => {
      // Greater than 0 also rules out the null of a loop that had to be killed.
      expect(
        guideVersion({ '0.7.0': hidden, '0.6.0': hidden }).status,
      ).toBeGreaterThan(0);
    });
  });

  it.each(pages)('%s marks every version for the generic updater', (page) => {
    let inBlock = false;
    const unmarked = [];
    for (const [index, line] of readFileSync(resolve(root, page), 'utf8')
      .split('\n')
      .entries()) {
      if (line.includes('x-release-please-start-version')) inBlock = true;
      if (line.includes('x-release-please-end')) inBlock = false;
      const versions = line.match(semver) ?? [];
      const marked = inBlock || line.includes('x-release-please-version');
      // Another product's version stays as written, so it must sit outside a version block.
      const other = line.includes('<!-- not-trinity-version -->');
      if (
        other
          ? marked || versions.length === 0
          : versions.length > (marked ? 1 : 0)
      )
        unmarked.push(`${index + 1}: ${line}`);
    }
    expect(unmarked).toEqual([]);
  });
});
