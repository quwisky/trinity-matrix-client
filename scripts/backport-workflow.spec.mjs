/** The backport workflow runs with secrets on PR events, so it must never touch PR-head code. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const source = readFileSync(
  resolve(import.meta.dirname, '../.github/workflows/backport.yml'),
  'utf8',
);
const workflow = parse(source);
const job = workflow.jobs.backport;
const at = (predicate) => job.steps.findIndex(predicate);

describe('Backport workflow', () => {
  it('runs for merged main PRs when labelled or closed', () => {
    expect(Object.keys(workflow.on)).toEqual(['pull_request_target']);
    expect(workflow.on.pull_request_target).toEqual({
      types: ['closed', 'labeled'],
      branches: ['main'],
    });
    expect(job.if).toContain('merged == true');
    expect(job.if).toContain("github.event.action == 'closed'");
    expect(job.if).toContain(
      "startsWith(github.event.label.name, 'backport release/')",
    );
  });

  it('holds the release App key and checks out main only', () => {
    expect(job.environment).toBe('release-app');
    const token = job.steps.find((step) => step.id === 'app-token');
    expect(token.with['client-id']).toBe('${{ vars.RELEASE_APP_CLIENT_ID }}');
    expect(token.with['private-key']).toBe(
      '${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
    );
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    expect(checkout.with.ref).toBe('main');
    expect(source).not.toContain('pull_request.head');
  });

  it('passes untrusted values to the shell only through env', () => {
    const script =
      job.steps[at((step) => step.run?.includes('scripts/backport.mjs'))];
    expect(script.run).not.toContain('${{');
    expect(script.run).toContain('--title="$TITLE"');
    expect(script.env.TITLE).toBe('${{ github.event.pull_request.title }}');
    expect(script.env.LABELS).toContain('pull_request.labels');
  });

  it('processes only the label just added on a labeled event', () => {
    const script =
      job.steps[at((step) => step.run?.includes('scripts/backport.mjs'))];
    expect(script.env.LABEL).toBe('${{ github.event.label.name }}');
    expect(script.env.ACTION).toBe('${{ github.event.action }}');
    expect(script.run).toContain('[ "$ACTION" = labeled ]');
    expect(script.run).toContain('--only="$LABEL"');
  });

  it('sets up node before running the script', () => {
    expect(
      at((step) => step.uses?.startsWith('actions/setup-node@')),
    ).toBeLessThan(at((step) => step.run?.includes('scripts/backport.mjs')));
  });
});
