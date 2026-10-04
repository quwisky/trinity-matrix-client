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
    expect(resolveRun).toContain('echo "branch=release/$major.$minor.x"');
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
      'Check out the prerelease',
      'Pin the stable version',
      'Create the release branch',
    ]) {
      expect(job.steps[index(name)].if).toBe('${{ !inputs.dry_run }}');
    }
  });

  it('creates the branch in one push whose commit pins the stable version', () => {
    const token = job.steps[index('Mint the App token')];
    expect(token.uses).toBe(
      'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
    );
    expect(token.with).toEqual({
      'client-id': '${{ vars.RENOVATE_APP_CLIENT_ID }}',
      'private-key': '${{ secrets.RENOVATE_APP_PRIVATE_KEY }}',
    });
    const checkout = job.steps[index('Check out the prerelease')];
    expect(checkout.uses).toBe(
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    );
    expect(checkout.with).toMatchObject({
      ref: '${{ steps.from.outputs.sha }}',
      token: '${{ steps.app-token.outputs.token }}',
    });
    const pin = job.steps[index('Pin the stable version')].run;
    expect(pin).toContain('.packages["."]["release-as"] = $version');
    expect(pin).toContain('release-please-config.json');
    expect(pin).toContain('trinity-release[bot]');
    expect(pin).toContain('chore(release): release v$VERSION from this branch');
    const push = job.steps[index('Create the release branch')].run;
    expect(push).toContain('git push origin "HEAD:refs/heads/$BRANCH"');
    expect(index('Pin the stable version')).toBeLessThan(
      index('Create the release branch'),
    );
    // release.yml opens the stable release PR from the push; no CLI call may race it.
    expect(source).not.toContain('release-please@');
    expect(source).not.toMatch(/--force\b|push -f|\+HEAD:/);
  });
});
