/**
 * Opens a PR that cherry-picks a merged fix from main onto each release branch named by a
 * `backport release/X.Y.x` label (see backport.yml). A pick that conflicts is left to a maintainer.
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const LABEL = /^backport (release\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.x)$/;

export const backportTargets = (labels) => [
  ...new Set(labels.map((label) => LABEL.exec(label)?.[1]).filter(Boolean)),
];

export const backportBranch = (pr, target) =>
  `backport/${pr}-${target.replace('/', '-')}`;

export const cherryPickArgs = (sha, parents) =>
  parents > 1
    ? ['cherry-pick', '-x', '-m', '1', sha]
    : ['cherry-pick', '-x', sha];

export function planBackport({ branchExists, existingPr, targetExists }) {
  if (!targetExists) return 'missing-target';
  return branchExists || existingPr !== null ? 'skip' : 'create';
}

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const succeeds = (command, args) => {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export const parentCount = (sha, cwd = process.cwd()) =>
  run('git', ['rev-list', '--parents', '-n', '1', sha], cwd).split(' ').length -
  1;

/**
 * A rebase-merged PR lands as N commits and merge_commit_sha is only the last, so the range
 * is picked when main's last N subjects (oldest first) are the PR's own. Squash and merge
 * commits stay a single pick.
 */
export function pickPlan({ sha, parents, prHeadlines, mainSubjects }) {
  const n = prHeadlines.length;
  if (
    parents === 1 &&
    n > 1 &&
    mainSubjects.length === n &&
    mainSubjects.every((subject, i) => subject === prHeadlines[i])
  ) {
    return {
      kind: 'range',
      args: ['cherry-pick', '-x', `${sha}~${n}..${sha}`],
    };
  }
  return { kind: 'single', args: cherryPickArgs(sha, parents) };
}

export function planPick({ sha, prHeadlines = [], cwd = process.cwd() }) {
  const n = prHeadlines.length;
  const mainSubjects =
    n > 1
      ? run('git', ['log', '--format=%s', '-n', String(n), sha], cwd)
          .split('\n')
          .reverse()
      : [];
  return pickPlan({
    sha,
    parents: parentCount(sha, cwd),
    prHeadlines,
    mainSubjects,
  });
}

/**
 * Picks sha (or its rebased range) onto a fresh branch cut from origin/target. Returns
 * 'picked', 'conflict' or 'empty' (already on the branch); a failed pick leaves nothing behind.
 */
export function cherryPickOnto({
  sha,
  target,
  branch,
  prHeadlines = [],
  cwd = process.cwd(),
}) {
  const git = (...args) => run('git', args, cwd);
  git('fetch', 'origin', target);
  const { args } = planPick({ sha, prHeadlines, cwd });
  git('switch', '-q', '-C', branch, `origin/${target}`);
  try {
    git(...args);
    return 'picked';
  } catch {
    const conflicted = git('diff', '--name-only', '--diff-filter=U') !== '';
    const staged = !succeeds('git', ['-C', cwd, 'diff', '--cached', '--quiet']);
    git('cherry-pick', '--abort');
    git('switch', '-q', '-');
    git('branch', '-D', branch);
    return conflicted || staged ? 'conflict' : 'empty';
  }
}

export function backportOne({ pr, title, sha, target, prHeadlines = [] }) {
  const branch = backportBranch(pr, target);
  const found = (ref) =>
    succeeds('git', [
      'ls-remote',
      '--exit-code',
      'origin',
      `refs/heads/${ref}`,
    ]);
  const targetExists = found(target);
  const branchExists = targetExists && found(branch);
  const existing = targetExists
    ? run('gh', [
        'pr',
        'list',
        '--head',
        branch,
        '--base',
        target,
        '--state',
        'all',
        '--json',
        'number',
        '-q',
        '.[0].number',
      ])
    : '';
  const plan = planBackport({
    targetExists,
    branchExists,
    existingPr: existing === '' ? null : Number(existing),
  });
  if (plan === 'missing-target') return { status: 'missing-target' };
  if (plan === 'skip') {
    return {
      status: 'skipped',
      reason: branchExists
        ? `${branch} already exists on origin`
        : `PR #${existing} already exists`,
    };
  }
  const picked = cherryPickOnto({ sha, target, branch, prHeadlines });
  if (picked !== 'picked') return { status: picked };
  run('git', ['push', 'origin', branch]);
  const url = run('gh', [
    'pr',
    'create',
    '--base',
    target,
    '--head',
    branch,
    '--title',
    `${title} (backport to ${target})`,
    '--body',
    `Backport of #${pr} to \`${target}\`, cherry-picked from ${sha}.`,
  ]);
  return { status: 'created', url };
}

const manual = ({ pr, sha, target, prHeadlines }) => {
  const pick = planPick({ sha, prHeadlines }).args.join(' ');
  return `\`git fetch origin && git switch -c ${backportBranch(pr, target)} origin/${target} && git ${pick}\`, resolve any conflicts, push the branch and open a PR into \`${target}\`.`;
};

const PROBLEMS = {
  conflict: 'The cherry-pick conflicts',
  empty: 'The fix is already on the branch (the cherry-pick is empty)',
  'missing-target': 'The branch does not exist',
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      pr: { type: 'string' },
      title: { type: 'string' },
      sha: { type: 'string' },
      'labels-json': { type: 'string' },
    },
  });
  const { pr, title, sha } = values;
  const prHeadlines = run('gh', [
    'pr',
    'view',
    pr,
    '--json',
    'commits',
    '-q',
    '.commits[].messageHeadline',
  ])
    .split('\n')
    .filter(Boolean);
  const failed = [];
  for (const target of backportTargets(JSON.parse(values['labels-json']))) {
    const result = backportOne({ pr, title, sha, target, prHeadlines });
    const detail = result.url ?? result.reason ?? '';
    console.log(`${target}: ${result.status} ${detail}`.trimEnd());
    if (result.status in PROBLEMS)
      failed.push({ target, status: result.status });
  }
  if (failed.length > 0) {
    const lines = failed.map(({ target, status }) =>
      status === 'empty'
        ? `- \`${target}\`: ${PROBLEMS[status]}; nothing to backport.`
        : `- \`${target}\`: ${PROBLEMS[status]}. Run ${manual({ pr, sha, target, prHeadlines })}`,
    );
    run('gh', [
      'pr',
      'comment',
      pr,
      '--body',
      `Could not open every backport automatically.\n\n${lines.join('\n')}`,
    ]);
  }
}
