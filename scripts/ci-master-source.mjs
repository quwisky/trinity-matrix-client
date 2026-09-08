#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

export const TRUSTED_REPOSITORY = Object.freeze({
  id: 1283201912,
  fullName: 'quwisky/trinity-matrix-client',
});

const isIntegerId = (value) =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
  (typeof value === 'string' &&
    /^(?:[1-9]\d*)$/u.test(value) &&
    Number(value) <= Number.MAX_SAFE_INTEGER);

const idEquals = (value, expected) =>
  isIntegerId(value) && Number(value) === expected;

const repositoryIsTrusted = (repository) =>
  repository &&
  idEquals(repository.id, TRUSTED_REPOSITORY.id) &&
  repository.full_name === TRUSTED_REPOSITORY.fullName;

const failure = (...failures) => ({ ok: false, applicable: true, failures });

const pullRequestMetadataMatchesEvent = (event, pullRequest) => {
  const request = event.pull_request;
  if (!pullRequest || typeof pullRequest !== 'object')
    return failure('missing fresh pull request API metadata');
  if (pullRequest.state !== 'open')
    return failure('fresh pull request is not open');
  if (pullRequest.number !== Number(request.number))
    return failure('API pull request number conflicts with event');
  const eventBase = request.base;
  const eventHead = request.head;
  const apiBase = pullRequest.base;
  const apiHead = pullRequest.head;
  if (
    apiBase?.ref !== eventBase.ref ||
    apiHead?.ref !== eventHead.ref ||
    apiHead?.sha !== eventHead.sha ||
    !apiBase?.repo ||
    !apiHead?.repo ||
    apiBase.repo.id !== eventBase.repo.id ||
    apiBase.repo.full_name !== eventBase.repo.full_name ||
    apiHead.repo.id !== eventHead.repo.id ||
    apiHead.repo.full_name !== eventHead.repo.full_name
  )
    return failure('fresh pull request metadata conflicts with event');
  return { ok: true, applicable: true, failures: [] };
};

const validReleaseIdentity = (identity) =>
  identity &&
  idEquals(identity.appId, Number(identity.appId)) &&
  idEquals(identity.botUserId, Number(identity.botUserId)) &&
  typeof identity.slug === 'string' &&
  /^[a-z0-9][a-z0-9-]*$/u.test(identity.slug);

export const validateMasterSourceEvent = ({ event, eventName } = {}) => {
  if (!event || typeof event !== 'object') return failure('missing event');
  const effectiveEventName = eventName ?? event.event_name;
  if (effectiveEventName && effectiveEventName !== 'pull_request')
    return { ok: true, applicable: false, failures: [] };
  if (!event.pull_request)
    return effectiveEventName === 'pull_request'
      ? failure('malformed pull request event metadata')
      : { ok: true, applicable: false, failures: [] };
  if (!event.repository)
    return failure('malformed pull request event metadata');
  if (event.repository.full_name !== TRUSTED_REPOSITORY.fullName)
    return failure('event repository name is not trusted');
  if (!repositoryIsTrusted(event.repository))
    return failure('event repository identity is not trusted');

  const request = event.pull_request;
  const base = request.base;
  const head = request.head;
  if (
    !base ||
    !head ||
    typeof base.ref !== 'string' ||
    typeof head.ref !== 'string' ||
    !base.repo ||
    !head.repo
  )
    return failure('malformed pull request base or head metadata');
  if (base.ref !== 'master')
    return { ok: true, applicable: false, failures: [] };
  if (!repositoryIsTrusted(base.repo))
    return failure('master base repository identity is not trusted');
  if (!repositoryIsTrusted(head.repo))
    return failure('master head repository identity is not trusted');
  if (!isIntegerId(request.number))
    return failure('pull request number is malformed');
  if (
    typeof request.head.sha !== 'string' ||
    !/^[0-9a-f]{40}$/iu.test(request.head.sha)
  )
    return failure('event head SHA is malformed');
  return { ok: true, applicable: true, failures: [] };
};

export const evaluateMasterSource = ({
  event,
  eventName,
  pullRequest,
  releaseAppIdentity = null,
} = {}) => {
  const scope = validateMasterSourceEvent({ event, eventName });
  const effectiveEventName = eventName ?? event?.event_name;
  const isPullRequest = effectiveEventName
    ? effectiveEventName === 'pull_request'
    : Boolean(event?.pull_request);
  if (isPullRequest) {
    if (!scope.ok) return scope;
    const fresh = pullRequestMetadataMatchesEvent(event, pullRequest);
    if (!fresh.ok) return fresh;
  }
  if (!scope.ok || !scope.applicable) return scope;
  const request = event.pull_request;
  const { base, head } = request;

  const release = head.ref !== 'develop';
  if (
    release &&
    (!releaseAppIdentity || !validReleaseIdentity(releaseAppIdentity))
  )
    return failure(
      'master source is neither develop nor an enabled trusted App',
    );
  if (!pullRequest || typeof pullRequest !== 'object')
    return failure('missing fresh pull request API metadata');
  if (
    !repositoryIsTrusted(pullRequest.base?.repo) ||
    !repositoryIsTrusted(pullRequest.head?.repo)
  )
    return failure('API pull request repository identity is not trusted');
  if (pullRequest.head.sha !== request.head.sha)
    return failure('API pull request head SHA is stale or conflicting');
  if (release) {
    const author = pullRequest.user;
    if (
      author?.type !== 'Bot' ||
      !idEquals(author.id, Number(releaseAppIdentity.botUserId))
    )
      return failure('Release Please author is not the pinned bot identity');
  }
  return { ok: true, applicable: true, failures: [] };
};

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export const fetchPullRequest = ({ repository, number, runApi } = {}) => {
  if (typeof runApi === 'function') return runApi(repository, number);
  const output = execFileSync(
    'gh',
    [
      'api',
      '--hostname',
      'github.com',
      '--method',
      'GET',
      `repos/${repository}/pulls/${number}`,
      '--header',
      'Accept: application/vnd.github+json',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(output);
};

export const main = ({ env = process.env, runApi } = {}) => {
  let event;
  try {
    event = readJson(env.GITHUB_EVENT_PATH);
  } catch {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      '## Master source guard\n\n- missing or malformed event metadata\n',
    );
    return { ok: false, exitCode: 1 };
  }
  let pullRequest;
  const effectiveEventName = env.GITHUB_EVENT_NAME ?? event.event_name;
  const isPullRequest = effectiveEventName
    ? effectiveEventName === 'pull_request'
    : Boolean(event.pull_request);
  if (isPullRequest) {
    if (
      !event.pull_request ||
      !isIntegerId(event.pull_request.number) ||
      env.GITHUB_REPOSITORY !== TRUSTED_REPOSITORY.fullName
    ) {
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        '## Master source guard\n\n- malformed repository or pull request metadata\n',
      );
      return { ok: false, exitCode: 1 };
    }
    try {
      pullRequest = fetchPullRequest({
        repository: env.GITHUB_REPOSITORY,
        number: event.pull_request.number,
        runApi,
      });
    } catch {
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        '## Master source guard\n\n- fresh pull request API read failed\n',
      );
      return { ok: false, exitCode: 1 };
    }
  }
  const result = evaluateMasterSource({
    event,
    eventName: env.GITHUB_EVENT_NAME,
    pullRequest,
  });
  const detail = result.ok
    ? result.applicable
      ? 'validated same-repository master promotion source'
      : 'not applicable for this event'
    : result.failures.map((item) => `- ${item}`).join('\n');
  appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    `## Master source guard\n\n${detail}\n`,
  );
  return { ...result, exitCode: result.ok ? 0 : 1 };
};

if (import.meta.url === `file://${process.argv[1]}`)
  process.exitCode = main().exitCode;
