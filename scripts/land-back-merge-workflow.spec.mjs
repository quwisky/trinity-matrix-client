/** The land workflow pushes to main as a ruleset bypass actor, so its trigger and scope are pinned. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const read = (name) =>
  parse(
    readFileSync(
      resolve(import.meta.dirname, '../.github/workflows', name),
      'utf8',
    ),
  );
const workflow = read('land-back-merge.yml');
const job = workflow.jobs.land;
const at = (predicate) => job.steps.findIndex(predicate);
const script = () =>
  job.steps[at((step) => step.run?.includes('scripts/land-back-merge.mjs'))];

describe('Land back-merge workflow', () => {
  it('runs only when the CI workflow completes', () => {
    expect(workflow.on).toEqual({
      workflow_run: { workflows: [read('ci.yml').name], types: ['completed'] },
    });
  });

  it('lands only green back-merge branches from this repository', () => {
    const run = 'github.event.workflow_run';
    expect(job.if).toContain(`${run}.conclusion == 'success'`);
    expect(job.if).toContain(`startsWith(${run}.head_branch, 'back-merge/')`);
    expect(job.if).toContain(
      `${run}.head_repository.full_name == github.repository`,
    );
  });

  it('grants nothing by default and only checks: read to GITHUB_TOKEN', () => {
    expect(workflow.permissions).toEqual({});
    expect(job.permissions).toEqual({ checks: 'read' });
  });

  it('pushes with the release App token from the release-app environment', () => {
    expect(job.environment).toBe('release-app');
    const token = job.steps.find((step) => step.id === 'app-token');
    expect(token.uses).toBe(
      'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
    );
    expect(token.with).toEqual({
      'client-id': '${{ vars.RELEASE_APP_CLIENT_ID }}',
      'private-key': '${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
    });
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    expect(checkout.with).toEqual({
      ref: 'main',
      'fetch-depth': 0,
      token: '${{ steps.app-token.outputs.token }}',
    });
  });

  it('pins every action to a commit SHA', () => {
    for (const step of job.steps.filter((s) => s.uses)) {
      expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
    }
  });

  it('passes the branch name to the script only through env', () => {
    const step = script();
    expect(step.run).toBe(
      'node scripts/land-back-merge.mjs --branch "$BRANCH"',
    );
    expect(step.env.BRANCH).toBe(
      '${{ github.event.workflow_run.head_branch }}',
    );
    expect(step.env.GH_TOKEN).toBe('${{ github.token }}');
    expect(at((s) => s.uses?.startsWith('actions/setup-node@'))).toBeLessThan(
      at((s) => s === step),
    );
  });
});
