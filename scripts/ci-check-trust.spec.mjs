import { describe, expect, it } from 'vitest';
import {
  TRUST,
  TrustError,
  createGitHubCollector,
  evaluateEvidence,
  verifyBranchTip,
  verifyReleaseCi,
} from './ci-check-trust.mjs';

const sha = 'a'.repeat(40);
const base = () => {
  const run = {
    id: 41,
    run_id: 41,
    run_attempt: 2,
    workflow_id: TRUST.workflowId,
    path: TRUST.workflowPath,
    repository: { id: TRUST.repositoryId, full_name: TRUST.repository },
    head_repository: {
      id: TRUST.repositoryId,
      full_name: TRUST.repository,
    },
    head_branch: 'master',
    head_sha: sha,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    check_suite_id: 501,
    html_url:
      'https://github.com/quwisky/trinity-matrix-client/actions/runs/41',
  };
  const job = {
    id: 901,
    run_id: 41,
    run_attempt: 2,
    head_sha: sha,
    name: TRUST.checkName,
    status: 'completed',
    conclusion: 'success',
    html_url:
      'https://github.com/quwisky/trinity-matrix-client/actions/runs/41/job/91',
    check_run_url:
      'https://api.github.com/repos/quwisky/trinity-matrix-client/check-runs/901',
  };
  return {
    run,
    attempt: (() => {
      const { run_id: _runId, ...attempt } = run;
      return attempt;
    })(),
    jobs: [job],
    check: {
      id: 901,
      name: TRUST.checkName,
      head_sha: sha,
      status: 'completed',
      conclusion: 'success',
      check_suite: { id: 501 },
      app: { id: TRUST.checkAppId, slug: TRUST.checkAppSlug },
    },
  };
};

const evidence = (changes = {}) => {
  const value = base();
  Object.assign(value.run, changes.run);
  Object.assign(value.attempt, changes.attempt);
  if (changes.job) Object.assign(value.jobs[0], changes.job);
  if (changes.check) Object.assign(value.check, changes.check);
  return { branch: 'master', sha, runs: [value.run], ...value };
};

function rejects(input, text) {
  expect(() => evaluateEvidence(input)).toThrowError(new RegExp(text));
}

describe('CI check trust evidence', () => {
  it('accepts exactly one successful Required check from the latest successful retry', () => {
    const result = evaluateEvidence(evidence());
    expect(result).toMatchObject({
      run_id: 41,
      run_attempt: 2,
      check_app_id: 15368,
    });
  });

  it.each([
    [
      'repository',
      { run: { repository: { id: 9, full_name: TRUST.repository } } },
    ],
    ['workflow', { run: { workflow_id: 9 } }],
    ['workflow path', { run: { path: '.github/workflows/other.yml' } }],
    ['event', { run: { event: 'pull_request' } }],
    ['branch', { run: { head_branch: 'develop' } }],
    ['sha', { run: { head_sha: 'b'.repeat(40) } }],
    ['App', { check: { app: { id: 7, slug: TRUST.checkAppSlug } } }],
    [
      'head repository',
      { run: { head_repository: { id: 7, full_name: TRUST.repository } } },
    ],
  ])('rejects a wrong %s identity', (_name, changes) =>
    rejects(evidence(changes), 'mismatch'),
  );

  it('rejects duplicate, conflicting, and ambiguous run records', () => {
    const input = evidence();
    expect(
      evaluateEvidence({ ...input, runs: [input.run, input.run] }),
    ).toMatchObject({ run_id: 41 });
    rejects(
      { ...input, runs: [input.run, { ...input.run, status: 'queued' }] },
      'conflicting',
    );
    rejects(
      { ...input, runs: [input.run, { ...input.run, id: 42 }] },
      'ambiguous',
    );
  });

  it.each([
    ['missing', []],
    ['duplicate', [base().jobs[0], { ...base().jobs[0], id: 92 }]],
    ['failed', [{ ...base().jobs[0], conclusion: 'failure' }]],
  ])('rejects %s Required job evidence', (_name, jobs) =>
    rejects({ ...evidence(), jobs }, 'Required'),
  );

  it.each([
    ['failed run', { run: { conclusion: 'failure', status: 'completed' } }],
    ['running run', { run: { conclusion: null, status: 'in_progress' } }],
    ['cancelled attempt', { attempt: { conclusion: 'cancelled' } }],
    ['wrong check suite', { check: { check_suite: { id: 99 } } }],
    ['incomplete check', { check: { status: 'queued' } }],
    ['wrong check name', { check: { name: 'Required' } }],
    [
      'wrong check URL host',
      { job: { check_run_url: 'https://evil.example/check' } },
    ],
  ])('rejects %s', (_name, changes) => rejects(evidence(changes), ''));

  it('rejects malformed SHA and release evidence on develop', async () => {
    expect(() => evaluateEvidence(evidence({})).toString()).not.toThrow;
    rejects({ ...evidence(), sha: 'short' }, 'full commit SHA');
    const input = evidence({ run: { head_branch: 'develop' } });
    await expect(
      verifyReleaseCi({
        sha,
        collector: {
          listRuns: async () => input.runs,
          getRun: async () => input.run,
          getAttempt: async () => input.attempt,
          listJobs: async () => input.jobs,
          getCheck: async () => input.check,
        },
      }),
    ).rejects.toBeInstanceOf(TrustError);
  });

  it('requires the branch tip to remain fixed across collection', async () => {
    const input = evidence();
    let reads = 0;
    const collector = {
      getRef: async () => ({ object: { sha: reads++ ? 'b'.repeat(40) : sha } }),
      listRuns: async () => input.runs,
      getRun: async () => input.run,
      getAttempt: async () => input.attempt,
      listJobs: async () => input.jobs,
      getCheck: async () => input.check,
    };
    await expect(
      verifyBranchTip({ branch: 'master', sha, collector }),
    ).rejects.toThrow(/moved/);
  });

  it('requires unique cardinality for pagination and accepts distinct job pages', async () => {
    const input = evidence();
    const requests = [];
    const paged = createGitHubCollector({
      request: async (_path, query) => {
        requests.push(query.page);
        return query.page === 1
          ? {
              total_count: 101,
              workflow_runs: Array.from({ length: 100 }, () => input.run),
            }
          : { total_count: 101, workflow_runs: [input.run] };
      },
    });
    await expect(paged.listRuns({ branch: 'master', sha })).rejects.toThrow(
      /incomplete.*deduplication/,
    );
    expect(requests).toEqual([1, 2]);
    await expect(
      createGitHubCollector({
        request: async (_path, query) => ({
          total_count: 101,
          workflow_runs: query.page === 1 ? [input.run] : [],
        }),
      }).listRuns({ branch: 'master', sha }),
    ).rejects.toThrow(/truncated/);
    const jobs = createGitHubCollector({
      request: async (_path, query) => ({
        total_count: 101,
        jobs:
          query.page === 1
            ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))
            : [{ id: 101 }],
      }),
    });
    await expect(jobs.listJobs(41, 2)).resolves.toHaveLength(101);
    await expect(
      createGitHubCollector({
        request: async () => ({ total_count: 0, workflow_runs: [input.run] }),
      }).listRuns({ branch: 'master', sha }),
    ).rejects.toThrow(/incomplete/);
    const collector = {
      getRef: async () => ({ object: { sha } }),
      listRuns: async () => [input.run],
      getRun: async () => input.run,
      getAttempt: async () => input.attempt,
      listJobs: async () => input.jobs,
      getCheck: async () => input.check,
    };
    await expect(
      verifyBranchTip({ branch: 'master', sha, collector }),
    ).resolves.toMatchObject({ run_id: 41 });
  });

  it('rejects a changed run attempt during the final reread', async () => {
    const input = evidence();
    let reads = 0;
    const collector = {
      listRuns: async () => input.runs,
      getRun: async () =>
        reads++ === 0 ? input.run : { ...input.run, run_attempt: 3 },
      getAttempt: async () => input.attempt,
      listJobs: async () => input.jobs,
      getCheck: async () => input.check,
    };
    await expect(verifyReleaseCi({ sha, collector })).rejects.toThrow(
      /changed/,
    );
  });
});
