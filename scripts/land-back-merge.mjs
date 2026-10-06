/**
 * Lands a back-merge PR's merge commit on main by a plain fast-forward push (see
 * land-back-merge.yml). main allows only squash merges, so the merge commit that keeps
 * release tags reachable from main cannot go through the merge button; the release App
 * pushes it as a ruleset bypass actor, but only once main's required checks are green on
 * exactly that commit.
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
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

/** Each required check, judged by its latest run, must have passed. */
export function checkProblems(required, runs) {
  if (required.length === 0)
    return ['main has no required status checks to wait for'];
  const latest = new Map();
  for (const run of runs) {
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

/** checks(sha) returns { required: string[], runs: { id, name, status, conclusion }[] }. */
export function land({ branch, cwd = process.cwd(), checks }) {
  const tag = tagFor(branch);
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const succeeds = (...args) => {
    try {
      git(...args);
      return true;
    } catch {
      return false;
    }
  };
  git(
    'fetch',
    '--no-tags',
    'origin',
    '+refs/heads/main:refs/remotes/origin/main',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    `+refs/tags/${tag}:refs/tags/${tag}`,
  );
  const sha = git('rev-parse', `refs/remotes/origin/${branch}^{commit}`);
  const main = git('rev-parse', 'refs/remotes/origin/main^{commit}');
  const parents = git('rev-list', '--parents', '-n', '1', sha)
    .split(' ')
    .slice(1);
  if (parents.length < 2)
    throw new Error(`${branch} at ${sha} is not a merge commit; refusing.`);
  if (parents[0] !== main)
    throw new Error(
      `main has moved: ${branch} at ${sha} merges onto ${parents[0]}, but main is at ${main}. ` +
        'Re-run the back-merge job (Open the back-merge PR in release.yml), which rebuilds the merge from current main.',
    );
  if (!succeeds('merge-base', '--is-ancestor', tag, sha))
    throw new Error(`${branch} at ${sha} does not contain ${tag}; refusing.`);
  const { required, runs } = checks(sha);
  const problems = checkProblems(required, runs);
  if (problems.length > 0)
    throw new Error(
      `main's required checks are not green on ${sha}:\n  ${problems.join('\n  ')}`,
    );
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
    '.check_runs[] | {id, name, status, conclusion}',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { required, runs };
}

function branchOf(pr) {
  const { headRefName, isCrossRepository } = JSON.parse(
    gh('pr', 'view', pr, '--json', 'headRefName,isCrossRepository'),
  );
  if (isCrossRepository) throw new Error(`#${pr} comes from a fork; refusing.`);
  return headRefName;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { branch: { type: 'string' }, pr: { type: 'string' } },
  });
  const branch = values.branch ?? (values.pr && branchOf(values.pr));
  if (!branch) throw new Error('Pass --branch back-merge/vX.Y.Z or --pr N.');
  const sha = land({ branch, checks: liveChecks });
  console.log(`Landed ${branch} at ${sha} on main.`);
}
