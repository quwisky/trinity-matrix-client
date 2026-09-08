/**
 * Append exact-attempt GitHub Actions job and step timings to the step summary.
 * Reporting is deliberately best effort: it must never alter a CI result.
 */
const DEFAULT_PAGE_LIMIT = 20;
const DEFAULT_RECORD_LIMIT = 500;
const DEFAULT_DEADLINE_MS = 15_000;

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is unavailable`);
  return value;
};

export const elapsedSeconds = (startedAt, completedAt) => {
  if (!startedAt || !completedAt) return null;
  const elapsed = (Date.parse(completedAt) - Date.parse(startedAt)) / 1000;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
};

const formatElapsed = (seconds) =>
  seconds === null ? 'unavailable' : `${seconds.toFixed(1)}s`;

export const collectAttemptJobs = async ({
  repository,
  runId,
  attempt,
  token,
  fetchImpl = fetch,
  pageLimit = DEFAULT_PAGE_LIMIT,
  recordLimit = DEFAULT_RECORD_LIMIT,
  deadlineMs = DEFAULT_DEADLINE_MS,
}) => {
  if (!Number.isInteger(pageLimit) || pageLimit < 1)
    throw new Error('pageLimit must be a positive integer');
  if (!Number.isInteger(recordLimit) || recordLimit < 1)
    throw new Error('recordLimit must be a positive integer');
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1)
    throw new Error('deadlineMs must be a positive integer');
  if (!/^\d+$/.test(String(runId)) || Number(runId) < 1)
    throw new Error('runId must be a positive integer');
  if (!/^\d+$/.test(String(attempt)) || Number(attempt) < 1)
    throw new Error('attempt must be a positive integer');
  const jobs = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    let totalCount;
    const seen = new Set();
    for (let page = 1; page <= pageLimit; page += 1) {
      const url = `https://api.github.com/repos/${repository}/actions/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(attempt)}/jobs?per_page=100&page=${page}`;
      const response = await Promise.race([
        fetchImpl(url, {
          signal: controller.signal,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
          },
        }),
        new Promise((_, reject) =>
          controller.signal.addEventListener(
            'abort',
            () =>
              reject(new Error('GitHub jobs API reporting deadline exceeded')),
            { once: true },
          ),
        ),
      ]);
      if (!response.ok)
        throw new Error(`GitHub jobs API returned ${response.status}`);
      const payload = await Promise.race([
        response.json(),
        new Promise((_, reject) =>
          controller.signal.addEventListener(
            'abort',
            () =>
              reject(new Error('GitHub jobs API reporting deadline exceeded')),
            { once: true },
          ),
        ),
      ]);
      if (
        !Number.isInteger(payload.total_count) ||
        payload.total_count < 0 ||
        !Array.isArray(payload.jobs)
      )
        throw new Error('GitHub jobs API returned malformed pagination');
      if (totalCount === undefined) totalCount = payload.total_count;
      if (payload.total_count !== totalCount)
        throw new Error(
          'GitHub jobs API total_count changed during pagination',
        );
      for (const job of payload.jobs) {
        if (!job || !/^\d+$/.test(String(job.id)) || Number(job.id) < 1)
          throw new Error('GitHub jobs API returned an invalid job id');
        if (
          String(job.run_id) !== String(runId) ||
          String(job.run_attempt) !== String(attempt)
        )
          throw new Error(
            'GitHub jobs API returned a job from another attempt',
          );
        if (seen.has(String(job.id)))
          throw new Error('GitHub jobs API returned duplicate jobs');
        seen.add(String(job.id));
        jobs.push(job);
      }
      if (jobs.length > recordLimit || totalCount > recordLimit)
        throw new Error('GitHub jobs API result exceeded reporting bound');
      const expectedPages = Math.max(1, Math.ceil(totalCount / 100));
      if (page === expectedPages) {
        if (jobs.length !== totalCount)
          throw new Error('GitHub jobs API pagination was incomplete');
        return jobs;
      }
      if (payload.jobs.length !== 100)
        throw new Error('GitHub jobs API pagination was incomplete');
    }
    throw new Error('GitHub jobs API pagination exceeded reporting bound');
  } finally {
    clearTimeout(timer);
  }
};

export const renderTimingSummary = (jobs, label = 'CI timing') => {
  const lines = [
    `### ${label}`,
    '',
    '| Job | Status | Elapsed |',
    '| --- | --- | --- |',
  ];
  for (const job of jobs) {
    lines.push(
      `| ${String(job.name ?? 'unnamed').replaceAll('|', '\\|')} | ${job.status ?? 'unavailable'}${job.conclusion ? ` (${job.conclusion})` : ''} | ${formatElapsed(elapsedSeconds(job.started_at, job.completed_at))} |`,
    );
    for (const step of job.steps ?? []) {
      lines.push(
        `| ↳ ${String(step.name ?? 'unnamed').replaceAll('|', '\\|')} | ${step.status ?? 'unavailable'}${step.conclusion ? ` (${step.conclusion})` : ''} | ${formatElapsed(elapsedSeconds(step.started_at, step.completed_at))} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
};

export const appendTimingSummary = async ({
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
  snapshotPath,
  label,
  ...options
}) => {
  const jobs = await collectAttemptJobs(options);
  const body = renderTimingSummary(jobs, label);
  if (summaryPath) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(summaryPath, body);
  }
  if (snapshotPath) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(
      snapshotPath,
      `${JSON.stringify({ repository: options.repository, runId: options.runId, attempt: options.attempt, jobs }, null, 2)}\n`,
    );
  }
  return jobs;
};

const main = async () => {
  const args = process.argv.slice(2);
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    await appendTimingSummary({
      repository: requiredEnv('GITHUB_REPOSITORY'),
      runId: requiredEnv('GITHUB_RUN_ID'),
      attempt: requiredEnv('GITHUB_RUN_ATTEMPT'),
      token:
        process.env.GH_TOKEN ??
        process.env.GITHUB_TOKEN ??
        requiredEnv('GH_TOKEN'),
      label: valueAfter('--label') ?? 'CI timing',
      summaryPath,
      snapshotPath: `dist/.ci/timing-jobs-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}.json`,
    });
  } catch (error) {
    await import('node:fs/promises').then(({ appendFile }) =>
      appendFile(
        summaryPath,
        `\n> Timing evidence unavailable: ${error.message}\n`,
      ),
    );
  }
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
