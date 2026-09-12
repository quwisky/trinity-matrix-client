#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const CODE_JOB_IDS = Object.freeze([
  'quality',
  'test',
  'renderer',
  'desktop',
  'e2e',
  'android-e2e',
  'ios-native-build',
]);
export const DOCS_JOB_IDS = Object.freeze(['docs-gate']);
const SHA = /^[0-9a-f]{40}$/i;
const ZERO_SHA = /^0+$/;
const ALLOWED_DOCS = [
  /^apps\/docs-(users|developers)\/src\/content\/docs\/(?:[^/]+\/)*[^/]+\.md$/,
];

export const expectedJobsForMode = (mode) => {
  if (mode === 'docs') return [...DOCS_JOB_IDS];
  if (mode === 'code') return [...CODE_JOB_IDS];
  return undefined;
};

const result = (mode, reason) => ({
  mode,
  reason,
  expectedJobs: expectedJobsForMode(mode),
});

const validPath = (path) =>
  typeof path === 'string' &&
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.startsWith('-') &&
  !path.includes('\\') &&
  !/[\u0000-\u001f\u007f]/.test(path) &&
  !path.split('/').some((part) => part === '' || part === '.' || part === '..');

export const isAllowedDocumentationPath = (path) =>
  validPath(path) && ALLOWED_DOCS.some((pattern) => pattern.test(path));

export const classifyChangedPaths = (paths) => {
  if (!Array.isArray(paths) || paths.length === 0) {
    return result('code', 'empty or unavailable diff');
  }
  if (!paths.every(validPath)) return result('code', 'malformed diff path');
  if (paths.every(isAllowedDocumentationPath)) {
    return result('docs', 'documentation-only changes');
  }
  return result('code', 'code or non-allowlisted changes');
};

const eventShas = (eventName, event) => {
  if (eventName === 'pull_request') {
    return {
      base: event?.pull_request?.base?.sha,
      head: event?.pull_request?.head?.sha,
      range: 'merge-base',
    };
  }
  if (eventName === 'push') {
    return { base: event?.before, head: event?.after, range: 'push' };
  }
  return undefined;
};

export const classifyEvent = (eventName, event, { diff } = {}) => {
  const shas = eventShas(eventName, event);
  if (!shas)
    return result('code', `unsupported event: ${eventName || 'unknown'}`);
  if (
    !SHA.test(shas.base ?? '') ||
    !SHA.test(shas.head ?? '') ||
    ZERO_SHA.test(shas.base) ||
    ZERO_SHA.test(shas.head)
  ) {
    return result('code', 'missing, malformed, or branch-creation SHA');
  }
  if (typeof diff !== 'function') return result('code', 'diff unavailable');
  try {
    return classifyChangedPaths(diff(shas));
  } catch {
    return { ...result('code', 'diff unavailable'), classifierFailed: true };
  }
};

export const gitDiff = (cwd, { base, head, range }) => {
  if (!SHA.test(base ?? '') || !SHA.test(head ?? '')) {
    throw new Error('invalid git revision');
  }
  if (range === 'merge-base') {
    const mergeBases = spawnSync('git', ['merge-base', '--all', base, head], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (
      mergeBases.error ||
      mergeBases.status !== 0 ||
      typeof mergeBases.stdout !== 'string' ||
      mergeBases.stdout.trim().split(/\s+/).filter(Boolean).length !== 1
    ) {
      throw new Error('ambiguous git merge base');
    }
  }
  const revision =
    range === 'merge-base' ? `${base}...${head}` : `${base}..${head}`;
  const process = spawnSync(
    'git',
    ['diff', '--no-renames', '--name-only', '-z', revision],
    {
      cwd,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  if (
    process.error ||
    process.status !== 0 ||
    !Buffer.isBuffer(process.stdout)
  ) {
    throw new Error('git diff failed');
  }
  return process.stdout.toString('utf8').split('\0').filter(Boolean);
};

const append = (file, value) => {
  if (file) appendFileSync(file, `${value}\n`, 'utf8');
};

export const main = ({ env = process.env, cwd = process.cwd() } = {}) => {
  let event;
  try {
    event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    const classification = {
      ...result('code', 'event payload unavailable'),
      classifierFailed: true,
    };
    append(env.GITHUB_OUTPUT, `mode=${classification.mode}`);
    append(
      env.GITHUB_OUTPUT,
      `classification=${JSON.stringify(classification)}`,
    );
    append(
      env.GITHUB_STEP_SUMMARY,
      `## CI classification\n\n${classification.reason}`,
    );
    return { classification, exitCode: 1 };
  }
  const classification = classifyEvent(env.GITHUB_EVENT_NAME, event, {
    diff: (revisions) => gitDiff(cwd, revisions),
  });
  append(env.GITHUB_OUTPUT, `mode=${classification.mode}`);
  append(env.GITHUB_OUTPUT, `classification=${JSON.stringify(classification)}`);
  append(
    env.GITHUB_STEP_SUMMARY,
    `## CI classification\n\n${classification.reason}`,
  );
  return { classification, exitCode: 0 };
};

if (import.meta.url === `file://${process.argv[1]}`)
  process.exitCode = main().exitCode;
