/** Stable release PRs carry the user guide to the new version; prereleases leave it alone. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

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
    const workflow = parse(
      readFileSync(resolve(root, '.github/workflows/docs-pages.yml'), 'utf8'),
    );

    it('redeploys from develop when a stable release is published', () => {
      expect(workflow.on.release.types).toEqual(['published']);
      const job = workflow.jobs.redeploy;
      expect(job.if).toBe(
        "github.event_name == 'release' && !github.event.release.prerelease",
      );
      expect(job.permissions).toEqual({ actions: 'write' });
      expect(job.steps.at(-1).run).toBe(
        'gh workflow run docs-pages.yml --ref develop',
      );
    });

    it('deploys only while the user guide version is a published release', () => {
      const check = workflow.jobs.build.steps.find(
        (step) => step.id === 'release',
      );
      expect(check.run).toContain(
        'jq -r .version apps/docs-users/release.json',
      );
      expect(check.run).toContain('gh release view "v$version"');
      expect(check.run).toContain('isDraft');
      expect(workflow.jobs.build.outputs.publish).toBe(
        '${{ steps.release.outputs.publish }}',
      );
      expect(workflow.jobs.deploy.if).toContain(
        "needs.build.outputs.publish == 'true'",
      );
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
      if (versions.length > (marked ? 1 : 0))
        unmarked.push(`${index + 1}: ${line}`);
    }
    expect(unmarked).toEqual([]);
  });
});
