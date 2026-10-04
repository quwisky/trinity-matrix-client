/** Release stable only cuts a new line from a published prerelease and never overwrites one. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(
  resolve(root, '.github/workflows/release-stable.yml'),
  'utf8',
);
const workflow = parse(source);
const job = workflow.jobs.cut;
const index = (name) => {
  const at = job.steps.findIndex((step) => step.name === name);
  expect(at, name).toBeGreaterThanOrEqual(0);
  return at;
};

describe('Release stable workflow', () => {
  it('is a manual dispatch with a prerelease tag and a dry run', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const { from, dry_run } = workflow.on.workflow_dispatch.inputs;
    expect(from.required).toBe(false);
    expect(dry_run).toMatchObject({ type: 'boolean', default: false });
    expect(workflow.concurrency).toEqual({
      group: 'release',
      'cancel-in-progress': false,
    });
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('checks the prerelease and refuses existing lines before pushing anything', () => {
    const resolveRun = job.steps[index('Resolve the prerelease')].run;
    expect(resolveRun).toContain('-next\\.(0|[1-9][0-9]*)$');
    expect(resolveRun).toContain('isDraft');
    expect(resolveRun).toContain('isPrerelease');
    expect(resolveRun).toContain(
      'contents/.github/workflows/release-stable.yml?ref=$FROM',
    );
    expect(resolveRun).toContain('predates the release-branch workflows');
    expect(resolveRun).toContain('compare/$FROM...main');
    expect(index('Resolve the prerelease')).toBeLessThan(
      index('Create the release branch'),
    );
    const refuse = job.steps[index('Refuse an existing line')].run;
    expect(refuse).toContain('refs/heads/$BRANCH');
    expect(refuse).toContain('refs/tags/');
    expect(index('Refuse an existing line')).toBeLessThan(
      index('Create the release branch'),
    );
  });

  it('stops after the checks on a dry run', () => {
    for (const name of [
      'Mint the App token',
      'Create the release branch',
      'Open the stable release PR',
    ]) {
      expect(job.steps[index(name)].if).toBe('${{ !inputs.dry_run }}');
    }
  });

  it('pushes and opens the PR with the App token and an exact version', () => {
    const token = job.steps[index('Mint the App token')];
    expect(token.uses).toBe(
      'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
    );
    const pr = job.steps[index('Open the stable release PR')].run;
    expect(pr).toContain('release-please@17.11.2 release-pr');
    expect(pr).toContain('--release-as "$VERSION"');
    expect(pr).toContain('--path .');
    expect(pr).toContain('--target-branch "$BRANCH"');
    expect(pr).toContain('--config-file release-please-config.json');
    expect(pr).toContain('--manifest-file .release-please-manifest.json');
    expect(source).not.toMatch(/--force\b|push -f/);
  });
});
