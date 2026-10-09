/** A red scheduled E2E run is only noticed if it opens an issue, so every such workflow must. */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const dir = resolve(import.meta.dirname, '../.github/workflows');
const read = (file) => readFileSync(resolve(dir, file), 'utf8');
const yaml = (file) => parse(read(file));

/** Each scheduled E2E workflow and the E2E jobs its `notify` job waits for. */
const NIGHTLY = {
  'ci.yml': ['scheduled-e2e'],
  'e2e-synapse-nightly.yml': ['browser', 'electron', 'protocol', 'mas'],
};
const ALERT = './.github/workflows/_nightly-alert.yml';
/** Scheduled runs and manual runs of `main`; never a pull request or another branch. */
const NOTIFY_IF =
  "${{ always() && github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') }}";

describe('Nightly E2E failure issue', () => {
  it.each(Object.entries(NIGHTLY))(
    '%s reports to the issue after %j',
    (file, needs) => {
      const workflow = yaml(file);
      const notify = workflow.jobs.notify;
      expect(notify.uses).toBe(ALERT);
      expect(notify.needs).toEqual(needs);
      expect(notify.if).toBe(NOTIFY_IF);
      expect(notify.with).toEqual({ needs: '${{ toJSON(needs) }}' });
      // Issue write access stays on the one job that files issues.
      expect(notify.permissions).toEqual({ issues: 'write' });
      // No `secrets:` (nor `secrets: inherit`): the alert only needs the job's own token.
      expect(notify).not.toHaveProperty('secrets');
      expect(workflow.permissions).toEqual({ contents: 'read' });
      for (const id of needs) expect(workflow.jobs[id], id).toBeDefined();
    },
  );

  it('covers every workflow that runs E2E on a schedule', () => {
    const scheduled = readdirSync(dir)
      .filter((file) => /\.ya?ml$/.test(file))
      .filter((file) => yaml(file).on?.schedule && /e2e/i.test(read(file)));
    for (const file of scheduled) {
      expect(Object.keys(NIGHTLY), file).toContain(file);
    }
  });

  it('keeps pushes to main from cancelling the weekly ci.yml run', () => {
    // The cron run's ref is main, like a push to main. Left in the push group, a push cancels
    // it mid-run and the alert reads that as a failure. Pushes and pull requests keep the
    // plain `<workflow>-<ref>` group; only the scheduled run gets its own.
    expect(yaml('ci.yml').concurrency).toEqual({
      group:
        "${{ github.workflow }}-${{ github.ref }}${{ github.event_name == 'schedule' && '-schedule' || '' }}",
      'cancel-in-progress': true,
    });
  });

  describe('reusable workflow', () => {
    const issueJob = () => yaml('_nightly-alert.yml').jobs.issue;
    const script = () =>
      issueJob()
        .steps.map((step) => step.run ?? '')
        .join('\n');

    it('takes the caller needs and can only write issues', () => {
      const alert = yaml('_nightly-alert.yml');
      const job = alert.jobs.issue;
      expect(alert.on.workflow_call.inputs.needs.required).toBe(true);
      expect(job.permissions).toEqual({ issues: 'write' });
      expect(job.env.GH_TOKEN).toBe('${{ github.token }}');
      expect(job.steps.some((step) => step.uses)).toBe(false);
    });

    it('interpolates nothing into a shell script', () => {
      // Expressions go through `env:`; a `${{ }}` inside `run:` would be shell-injectable.
      expect(script()).not.toContain('${{');
    });

    it('opens or reuses one issue per workflow, comments, and closes it when green', () => {
      expect(script()).toContain('Nightly E2E failing: $WORKFLOW');
      expect(script()).toContain(
        'gh issue list --state open --label ci-nightly',
      );
      expect(script()).toContain('gh issue create');
      expect(script()).toContain('gh issue comment');
      expect(script()).toContain('gh issue close');
    });
  });
});
