/** Promoting to stable merges with the App token and a merge commit, behind two gates. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(
  resolve(root, '.github/workflows/promote-stable.yml'),
  'utf8',
);
const workflow = parse(source);
const job = workflow.jobs.release;
const step = (name) => job.steps.find((s) => s.name === name);
const index = (name) => job.steps.findIndex((s) => s.name === name);

describe('Promote to stable workflow', () => {
  it('is a manual choice between promote and back-merge', () => {
    expect(workflow.name).toBe('Promote to stable');
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const input = workflow.on.workflow_dispatch.inputs.step;
    expect(input.type).toBe('choice');
    expect(input.required).toBe(true);
    expect(input.options).toEqual(['promote', 'back-merge']);
  });

  it('is serialized and read-only unless it holds the App token', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency).toEqual({
      group: 'promote-stable',
      'cancel-in-progress': false,
    });
    expect(Object.keys(workflow.jobs)).toEqual(['release']);
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBeLessThanOrEqual(15);
  });

  it('mints the Renovate App token with client-id and private-key', () => {
    const mint = job.steps.find((s) =>
      s.uses?.startsWith('actions/create-github-app-token@'),
    );
    expect(mint.with['client-id']).toBe('${{ vars.RENOVATE_APP_CLIENT_ID }}');
    expect(mint.with['private-key']).toBe(
      '${{ secrets.RENOVATE_APP_PRIVATE_KEY }}',
    );
    expect(mint.with).not.toHaveProperty('app-id');
  });

  it('pins every action by commit SHA', () => {
    for (const s of job.steps.filter((x) => x.uses)) {
      expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('never prints a token', () => {
    expect(source).not.toMatch(/echo[^\n]*token/i);
  });

  it('merges only with merge commits', () => {
    const merges = source.match(/gh pr merge[^\n]*/g) ?? [];
    expect(merges).toHaveLength(2);
    for (const merge of merges) expect(merge).toContain('--merge');
    expect(source).not.toContain('--squash');
    expect(source).not.toContain('--rebase');
  });

  it('writes with the App token, so release.yml runs on the merge', () => {
    for (const s of job.steps.filter((x) => /gh (pr|api)/.test(x.run ?? ''))) {
      expect(s.env.GH_TOKEN).toMatch(
        /steps\.\w[\w-]*\.outputs\.token|github\.token/,
      );
    }
    expect(job.env.GH_REPO).toBe('${{ github.repository }}');
    for (const merge of [
      'Promote develop to main',
      'Merge main back into develop',
    ]) {
      expect(step(merge).env.GH_TOKEN).toBe(
        '${{ steps.app-token.outputs.token }}',
      );
    }
  });

  it('gates the promote merge on a green ci.yml run for develop head', () => {
    const gate = step('Require green CI on develop');
    expect(gate.if).toContain("inputs.step == 'promote'");
    expect(gate.run).toContain(
      'gh run list --workflow ci.yml --branch develop',
    );
    expect(gate.run).toContain('--commit');
    expect(gate.run).toContain('success');
    expect(index('Require green CI on develop')).toBeLessThan(
      index('Promote develop to main'),
    );
    expect(index('Close the open release PR on develop')).toBeLessThan(
      index('Promote develop to main'),
    );
  });

  it('closes the develop release PR with an explanatory comment', () => {
    const run = step('Close the open release PR on develop').run;
    expect(run).toContain(
      'release-please--branches--develop--components--trinity',
    );
    expect(run).toContain('Superseded by the stable promotion');
  });

  it('gates the back-merge on a published, non-draft release', () => {
    const gate = step('Require the stable release to be published');
    expect(gate.if).toContain("inputs.step == 'back-merge'");
    expect(gate.run).toContain('.release-please-manifest.json');
    expect(gate.run).toContain('gh release view');
    expect(gate.run).toContain('isDraft');
    expect(gate.run).toContain('publish the draft first');
    expect(index('Require the stable release to be published')).toBeLessThan(
      index('Merge main back into develop'),
    );
  });

  it('fails a conflicting back-merge with instructions, never forcing', () => {
    const run = step('Merge main back into develop').run;
    expect(run).toContain('CONFLICTING');
    expect(run).toContain("main's values");
    expect(source).not.toMatch(/--force|--admin|push -f/);
  });
});
