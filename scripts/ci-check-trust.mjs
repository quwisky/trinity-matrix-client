import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const execFileAsync = promisify(execFile);

export const TRUST = Object.freeze({
  repositoryId: 1283201912,
  repository: 'quwisky/trinity-matrix-client',
  workflowId: 318169767,
  workflowPath: '.github/workflows/ci.yml',
  checkAppId: 15368,
  checkAppSlug: 'github-actions',
  checkName: 'CI / Required',
});

const API_ROOT = 'https://api.github.com';
const SHA = /^[0-9a-f]{40}$/;
const POSITIVE_INTEGER = (value) => Number.isSafeInteger(value) && value > 0;

export class TrustError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrustError';
  }
}

const fail = (message) => {
  throw new TrustError(message);
};
const object = (value, message) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : fail(message);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function validateSha(sha) {
  if (typeof sha !== 'string' || !SHA.test(sha))
    fail('expected full commit SHA');
  return sha;
}

function validateRepository(value, where = 'record') {
  const repo = object(value, `${where} repository is missing`);
  if (
    !POSITIVE_INTEGER(repo.id) ||
    repo.id !== TRUST.repositoryId ||
    repo.full_name !== TRUST.repository
  )
    fail(`${where} repository identity mismatch`);
}

function validateHeadRepository(value, where) {
  validateRepository(value, `${where} head repository`);
}

function validateRun(run, { branch, sha }, where = 'workflow run') {
  object(run, `${where} is missing`);
  if (!POSITIVE_INTEGER(run.id)) fail(`${where} has no positive numeric ID`);
  validateRepository(run.repository, where);
  validateHeadRepository(run.head_repository, where);
  if (run.workflow_id !== TRUST.workflowId || run.path !== TRUST.workflowPath)
    fail(`${where} workflow identity mismatch`);
  if (
    run.head_branch !== branch ||
    run.event !== 'push' ||
    run.head_sha !== sha
  )
    fail(`${where} source identity mismatch`);
}

function uniqueRuns(runs, expected) {
  if (!Array.isArray(runs)) fail('workflow run pagination is incomplete');
  const byId = new Map();
  for (const run of runs) {
    validateRun(run, expected);
    if (!Number.isInteger(run.id)) fail('workflow run has no numeric ID');
    const prior = byId.get(run.id);
    if (prior && !same(prior, run)) fail('conflicting duplicate workflow run');
    byId.set(run.id, run);
  }
  if (byId.size !== 1)
    fail(byId.size ? 'ambiguous workflow runs' : 'workflow run not found');
  return [...byId.values()][0];
}

function validateAttempt(attempt, run, sha) {
  object(attempt, 'attempt metadata is missing');
  if (!POSITIVE_INTEGER(attempt.id) || attempt.id !== run.id)
    fail('attempt/run linkage mismatch');
  validateRun(attempt, { branch: run.head_branch, sha }, 'attempt metadata');
  if (
    !POSITIVE_INTEGER(attempt.run_attempt) ||
    attempt.run_attempt !== run.run_attempt ||
    attempt.head_sha !== sha
  )
    fail('attempt identity mismatch');
  if (attempt.status !== 'completed' || attempt.conclusion !== 'success')
    fail('latest workflow attempt is not successful');
}

function validateJobs(jobs, run, sha) {
  if (!Array.isArray(jobs)) fail('attempt jobs pagination is incomplete');
  const requiredJobs = jobs.filter((job) => job?.name === TRUST.checkName);
  if (requiredJobs.length !== 1) fail('expected exactly one Required job');
  const job = requiredJobs[0];
  if (
    !POSITIVE_INTEGER(job.id) ||
    job.run_id !== run.id ||
    job.run_attempt !== run.run_attempt ||
    job.head_sha !== sha ||
    job.status !== 'completed' ||
    job.conclusion !== 'success' ||
    !POSITIVE_INTEGER(job.run_id) ||
    !POSITIVE_INTEGER(job.run_attempt)
  )
    fail('Required job identity or conclusion mismatch');
  if (typeof job.check_run_url !== 'string')
    fail('Required job check URL is missing');
  return job;
}

function parseCheckRunUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('check run URL is malformed');
  }
  const match =
    /^\/repos\/quwisky\/trinity-matrix-client\/check-runs\/([1-9][0-9]*)$/.exec(
      url.pathname,
    );
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match
  )
    fail('check run URL is outside the pinned repository API');
  const id = Number(match[1]);
  if (!POSITIVE_INTEGER(id)) fail('check run URL ID is invalid');
  return { url, id };
}

function validateCheck(check, job, run, sha) {
  object(check, 'check run metadata is missing');
  const { id: checkId } = parseCheckRunUrl(job.check_run_url);
  if (
    !POSITIVE_INTEGER(run.check_suite_id) ||
    !POSITIVE_INTEGER(check.id) ||
    check.id !== checkId ||
    check.name !== TRUST.checkName ||
    check.head_sha !== sha ||
    check.status !== 'completed' ||
    check.conclusion !== 'success' ||
    check.check_suite?.id !== run.check_suite_id ||
    check.app?.id !== TRUST.checkAppId ||
    check.app?.slug !== TRUST.checkAppSlug
  )
    fail('check run identity mismatch');
  return check;
}

/** Evaluate already-collected API evidence without network or filesystem access. */
export function evaluateEvidence({
  branch,
  sha,
  runs,
  run,
  attempt,
  jobs,
  check,
}) {
  if (branch !== 'develop' && branch !== 'master') fail('unsupported branch');
  validateSha(sha);
  const selected = uniqueRuns(runs, { branch, sha });
  if (selected.id !== run?.id)
    fail('current workflow run does not match listed run');
  validateRun(run, { branch, sha }, 'current workflow run');
  if (!POSITIVE_INTEGER(run.run_attempt))
    fail('workflow run attempt is invalid');
  if (run.status !== 'completed' || run.conclusion !== 'success')
    fail('latest workflow run is not successful');
  validateAttempt(attempt, run, sha);
  const job = validateJobs(jobs, run, sha);
  const checkRun = validateCheck(check, job, run, sha);
  return {
    repository: TRUST.repository,
    repository_id: TRUST.repositoryId,
    workflow_id: TRUST.workflowId,
    workflow_path: TRUST.workflowPath,
    branch,
    sha,
    run_id: run.id,
    run_attempt: run.run_attempt,
    check_suite_id: run.check_suite_id,
    required_job_id: job.id,
    required_check_id: checkRun.id,
    check_name: checkRun.name,
    check_app_id: checkRun.app.id,
    check_app_slug: checkRun.app.slug,
    conclusion: checkRun.conclusion,
    evidence: {
      run_url: run.html_url,
      job_url: job.html_url,
      check_url: job.check_run_url,
    },
  };
}

function endpoint(path) {
  if (!path.startsWith('/repos/quwisky/trinity-matrix-client/'))
    fail('collector endpoint is outside the pinned repository');
  return `${API_ROOT}${path}`;
}

async function ghRequest(path, query = {}) {
  const args = [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'GET',
    endpoint(path),
  ];
  for (const [key, value] of Object.entries(query))
    args.push('-f', `${key}=${value}`);
  const { stdout } = await execFileAsync('gh', args, {
    maxBuffer: 4 * 1024 * 1024,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    fail('GitHub API returned malformed JSON');
  }
}

function pageItems(response, key) {
  object(response, 'GitHub API response is malformed');
  if (!POSITIVE_INTEGER(response.total_count) && response.total_count !== 0)
    fail('GitHub API total_count is missing or invalid');
  const items = response[key];
  if (!Array.isArray(items))
    fail(`GitHub API pagination response is missing ${key}`);
  return { items, totalCount: response.total_count };
}

function completeUniqueRecords(records, totalCount, kind) {
  const byId = new Map();
  for (const record of records) {
    if (!POSITIVE_INTEGER(record?.id))
      fail(`${kind} pagination contains an invalid record ID`);
    const previous = byId.get(record.id);
    if (previous && !same(previous, record))
      fail(`conflicting duplicate ${kind} pagination record`);
    byId.set(record.id, record);
  }
  if (byId.size !== totalCount)
    fail(`incomplete ${kind} pagination after deduplication`);
  return [...byId.values()];
}

export function createGitHubCollector({ request = ghRequest } = {}) {
  const list = async (path, query, key) => {
    const all = [];
    let page = 1;
    let totalCount;
    for (;;) {
      const current = pageItems(
        await request(path, { ...query, page, per_page: 100 }),
        key,
      );
      if (totalCount === undefined) totalCount = current.totalCount;
      if (current.totalCount !== totalCount)
        fail('GitHub API total_count changed during pagination');
      all.push(...current.items);
      const expectedPages = Math.ceil(totalCount / 100);
      if (page >= expectedPages) {
        if (all.length < totalCount) fail('truncated GitHub API pagination');
        break;
      }
      if (current.items.length === 0) fail('truncated GitHub API pagination');
      page += 1;
    }
    return completeUniqueRecords(all, totalCount, key);
  };
  return {
    listRuns: ({ sha, branch }) =>
      list(
        `/repos/${TRUST.repository}/actions/workflows/${TRUST.workflowId}/runs`,
        {
          head_sha: sha,
          event: 'push',
          branch,
        },
        'workflow_runs',
      ),
    getRun: (id) => request(`/repos/${TRUST.repository}/actions/runs/${id}`),
    getAttempt: (id, attempt) =>
      request(
        `/repos/${TRUST.repository}/actions/runs/${id}/attempts/${attempt}`,
      ),
    listJobs: (id, attempt) =>
      list(
        `/repos/${TRUST.repository}/actions/runs/${id}/attempts/${attempt}/jobs`,
        {},
        'jobs',
      ),
    getCheck: (url) => {
      const { url: parsed } = parseCheckRunUrl(url);
      return request(parsed.pathname);
    },
    getRef: (branch) =>
      request(`/repos/${TRUST.repository}/git/ref/heads/${branch}`),
  };
}

async function collect(collector, branch, sha) {
  validateSha(sha);
  const runs = await collector.listRuns({ branch, sha });
  const listed = uniqueRuns(runs, { branch, sha });
  const run = await collector.getRun(listed.id);
  validateRun(run, { branch, sha }, 'current workflow run');
  if (run.id !== listed.id) fail('current workflow run ID changed');
  const attemptNumber = run.run_attempt;
  if (!POSITIVE_INTEGER(attemptNumber)) fail('workflow run attempt is invalid');
  const attempt = await collector.getAttempt(run.id, attemptNumber);
  const jobs = await collector.listJobs(run.id, attemptNumber);
  const job = validateJobs(jobs, run, sha);
  const check = await collector.getCheck(job.check_run_url);
  const evidence = evaluateEvidence({
    branch,
    sha,
    runs,
    run,
    attempt,
    jobs,
    check,
  });
  const reread = await collector.getRun(run.id);
  validateRun(reread, { branch, sha }, 're-read workflow run');
  if (
    reread.id !== run.id ||
    reread.run_attempt !== run.run_attempt ||
    reread.status !== run.status ||
    reread.conclusion !== run.conclusion ||
    reread.head_sha !== run.head_sha ||
    reread.workflow_id !== run.workflow_id ||
    reread.path !== run.path ||
    reread.check_suite_id !== run.check_suite_id
  )
    fail('workflow run changed during evidence collection');
  return evidence;
}

export async function verifyBranchTip({
  branch,
  sha,
  collector = createGitHubCollector(),
}) {
  if (branch !== 'develop' && branch !== 'master') fail('unsupported branch');
  validateSha(sha);
  const before = await collector.getRef(branch);
  if (before?.object?.sha !== sha)
    fail('branch tip does not match expected SHA');
  const evidence = await collect(collector, branch, sha);
  const after = await collector.getRef(branch);
  if (after?.object?.sha !== sha)
    fail('branch moved during evidence collection');
  return evidence;
}

export async function verifyReleaseCi({
  sha,
  collector = createGitHubCollector(),
}) {
  validateSha(sha);
  return collect(collector, 'master', sha);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  const allowed =
    mode === 'release'
      ? new Set(['--sha', '--out'])
      : mode === 'branch-tip'
        ? new Set(['--sha', '--out', '--branch'])
        : new Set();
  const optionArgs = process.argv.slice(3);
  let invalidOption = false;
  const seenOptions = new Set();
  for (let i = 0; i < optionArgs.length; i += 2) {
    if (
      !allowed.has(optionArgs[i]) ||
      seenOptions.has(optionArgs[i]) ||
      !optionArgs[i + 1] ||
      optionArgs[i + 1].startsWith('--')
    )
      invalidOption = true;
    seenOptions.add(optionArgs[i]);
  }
  const out = arg('--out');
  let result;
  try {
    if (invalidOption) throw new TrustError('invalid CLI options');
    const sha = arg('--sha');
    if (!out) throw new TrustError('--out is required');
    if (mode !== 'release' && mode !== 'branch-tip')
      throw new TrustError(
        'usage: release|branch-tip --sha <full-sha> --out <file>',
      );
    if (mode === 'branch-tip' && !arg('--branch'))
      throw new TrustError('--branch is required for branch-tip');
    const promise =
      mode === 'release'
        ? verifyReleaseCi({ sha })
        : verifyBranchTip({ branch: arg('--branch'), sha });
    result = { trusted: true, ...(await promise) };
  } catch (error) {
    result = {
      trusted: false,
      error: error instanceof Error ? error.message : String(error),
    };
    process.exitCode = 1;
  }
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(result));
  } else {
    console.log(JSON.stringify(result));
  }
}
