/**
 * Lands a back-merge PR's single metadata commit on main by a plain fast-forward push
 * (see land-back-merge.yml). main allows only squash merges, so the commit cannot go
 * through the merge button; the release App pushes it as a ruleset bypass actor, but only
 * through the open PR and once main's required checks are green on exactly that commit.
 * Bypassing skips the ruleset's PR rules,
 * so closing the PR, marking it draft or requesting changes stops a land.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildBackMerge, resolutionFor } from './back-merge.mjs';

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const METADATA = new Set(['release', 'higher']);
const PASSING = new Set(['success', 'skipped', 'neutral']);

export function tagFor(branch) {
  if (!branch?.startsWith('back-merge/'))
    throw new Error(`'${branch}' is not a back-merge/vX.Y.Z branch`);
  const tag = branch.slice('back-merge/'.length);
  if (!STABLE_TAG.test(tag))
    throw new Error(`'${tag}' is not a stable vX.Y.Z tag`);
  return tag;
}

/** No force and no lease: a non-fast-forward push must simply fail. */
export const pushArgs = (sha) => ['push', 'origin', `${sha}:refs/heads/main`];

/** Each required check, judged by its latest GitHub Actions run on sha, must have passed. */
export function checkProblems(required, runs, sha) {
  if (required.length === 0)
    return ['main has no required status checks to wait for'];
  const latest = new Map();
  for (const run of runs) {
    // Any token with checks: write could post a same-named run; only Actions runs ci.yml.
    if (run.head_sha !== sha || run.app !== 'github-actions') continue;
    if ((latest.get(run.name)?.id ?? -Infinity) < run.id)
      latest.set(run.name, run);
  }
  return required.flatMap((name) => {
    const run = latest.get(name);
    if (!run) return [`${name} has not reported`];
    if (run.status !== 'completed') return [`${name} is ${run.status}`];
    if (!PASSING.has(run.conclusion))
      return [`${name} concluded ${run.conclusion}`];
    return [];
  });
}

/** The landing goes through the PR: one open, ready, same-repo PR whose head is sha. */
export function prProblems(prs, sha) {
  const own = prs.filter((pr) => !pr.isCrossRepository);
  if (own.length === 0)
    return ['no open pull request from this repository into main'];
  if (own.length > 1)
    return [
      `more than one open pull request: ${own.map((pr) => `#${pr.number}`).join(', ')}`,
    ];
  const [pr] = own;
  return [
    ...(pr.isDraft ? [`#${pr.number} is a draft`] : []),
    ...(pr.headRefOid === sha
      ? []
      : [`#${pr.number} is at ${pr.headRefOid}, not ${sha}`]),
    ...(pr.reviewDecision === 'CHANGES_REQUESTED'
      ? [`#${pr.number} has changes requested`]
      : []),
  ];
}

/** Paths where sha's tree differs from the one main's back-merge.mjs builds for tag on main. */
function treeDiff(git, tag, main, sha) {
  const dir = mkdtempSync(join(tmpdir(), 'land-back-merge-'));
  try {
    git('worktree', 'add', '--detach', dir, main);
    buildBackMerge(tag, dir);
    const inDir = (...args) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
    const expected = inDir('write-tree');
    return git(
      'diff-tree',
      '-r',
      '--no-renames',
      '--name-only',
      expected,
      `${sha}^{tree}`,
    )
      .split('\n')
      .filter(Boolean);
  } finally {
    try {
      git('worktree', 'remove', '--force', dir);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * checks(sha) returns { required: string[], runs: { id, name, status, conclusion, head_sha, app }[] };
 * pulls(branch) returns the open PRs from branch into main. expectedSha is the commit CI ran on.
 */
export function land({
  branch,
  cwd = process.cwd(),
  checks,
  pulls,
  expectedSha,
}) {
  const tag = tagFor(branch);
  const line = `release/${tag.slice(1, tag.lastIndexOf('.'))}.x`;
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(
    'fetch',
    '--no-tags',
    'origin',
    '+refs/heads/main:refs/remotes/origin/main',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    `+refs/tags/${tag}:refs/tags/${tag}`,
  );
  if (!git('ls-remote', '--heads', 'origin', `refs/heads/${line}`))
    throw new Error(`origin has no ${line} branch for ${tag}; refusing.`);
  git(
    'fetch',
    '--no-tags',
    'origin',
    `+refs/heads/${line}:refs/remotes/origin/${line}`,
  );
  try {
    git(
      'merge-base',
      '--is-ancestor',
      `refs/tags/${tag}^{commit}`,
      `refs/remotes/origin/${line}`,
    );
  } catch {
    throw new Error(
      `${tag} is not on ${line}; refusing a tag that did not go through its release branch.`,
    );
  }
  const sha = git('rev-parse', `refs/remotes/origin/${branch}^{commit}`);
  if (expectedSha && sha !== expectedSha)
    throw new Error(
      `${branch} is at ${sha} but CI ran on ${expectedSha}; the run for ${sha} lands it.`,
    );
  const main = git('rev-parse', 'refs/remotes/origin/main^{commit}');
  const parents = git('rev-list', '--parents', '-n', '1', sha)
    .split(' ')
    .slice(1);
  if (parents.length !== 1)
    throw new Error(
      `${branch} at ${sha} is not a single-parent commit on main; refusing.` +
        (parents.length === 2
          ? ` A two-parent merge comes from a release line whose scripts/back-merge.mjs predates single-parent back-merges: update ${line}'s release.yml to the single-parent back-merge job (a direct PR, never the manifest) and re-run 'Open the back-merge PR'.`
          : ''),
    );
  if (parents[0] !== main)
    throw new Error(
      `main has moved: ${branch} at ${sha} is built on ${parents[0]}, but main is at ${main}. ` +
        'Re-run the back-merge job (Open the back-merge PR in release.yml), which rebuilds the commit from current main.',
    );
  const changed = git('diff', '--name-only', '--no-renames', main, sha)
    .split('\n')
    .filter(Boolean);
  if (changed.length === 0)
    throw new Error(
      `${branch} at ${sha} changes nothing: nothing to back-merge.`,
    );
  const foreign = changed.filter((path) => !METADATA.has(resolutionFor(path)));
  if (foreign.length > 0)
    throw new Error(
      `${branch} at ${sha} changes paths outside release metadata; refusing:\n  ${foreign.join('\n  ')}`,
    );
  const wrong = treeDiff(git, tag, main, sha);
  if (wrong.length > 0)
    throw new Error(
      `${branch} at ${sha} is not the tag's metadata on main; these paths differ from what scripts/back-merge.mjs builds for ${tag}:\n  ${wrong.join('\n  ')}`,
    );
  const { required, runs } = checks(sha);
  const problems = checkProblems(required, runs, sha);
  if (problems.length > 0)
    throw new Error(
      `main's required checks are not green on ${sha}:\n  ${problems.join('\n  ')}`,
    );
  const prIssues = prProblems(pulls(branch), sha);
  if (prIssues.length > 0)
    throw new Error(
      `The back-merge pull request is not ready to land ${sha}:\n  ${prIssues.join('\n  ')}`,
    );
  // A fast-forward or nothing: if main moved since the check above, git rejects the push.
  git(...pushArgs(sha));
  return sha;
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();

/** Live from main's branch rules, so a ruleset change needs no edit here. */
function liveChecks(sha) {
  const required = JSON.parse(
    gh(
      'api',
      'repos/{owner}/{repo}/rules/branches/main',
      '--jq',
      '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context]',
    ),
  );
  const runs = gh(
    'api',
    '--paginate',
    `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`,
    '--jq',
    '.check_runs[] | {id, name, status, conclusion, head_sha, app: .app.slug}',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { required, runs };
}

const livePulls = (branch) =>
  JSON.parse(
    gh(
      'pr',
      'list',
      '--head',
      branch,
      '--base',
      'main',
      '--state',
      'open',
      '--json',
      'number,isDraft,isCrossRepository,headRefOid,reviewDecision',
    ),
  );

function branchOf(pr) {
  const { headRefName, isCrossRepository } = JSON.parse(
    gh('pr', 'view', pr, '--json', 'headRefName,isCrossRepository'),
  );
  if (isCrossRepository) throw new Error(`#${pr} comes from a fork; refusing.`);
  return headRefName;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      branch: { type: 'string' },
      pr: { type: 'string' },
      sha: { type: 'string' },
    },
  });
  const branch = values.branch ?? (values.pr && branchOf(values.pr));
  if (!branch) throw new Error('Pass --branch back-merge/vX.Y.Z or --pr N.');
  const sha = land({
    branch,
    checks: liveChecks,
    pulls: livePulls,
    expectedSha: values.sha,
  });
  console.log(`Landed ${branch} at ${sha} on main.`);
}
