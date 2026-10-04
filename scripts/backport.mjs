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

/** Picks sha onto a fresh branch cut from origin/target; on conflict nothing is left behind. */
export function cherryPickOnto({ sha, target, branch, cwd = process.cwd() }) {
  const git = (...args) => run('git', args, cwd);
  git('fetch', 'origin', target);
  git('switch', '-q', '-C', branch, `origin/${target}`);
  const parents =
    git('rev-list', '--parents', '-n', '1', sha).split(' ').length - 1;
  try {
    git(...cherryPickArgs(sha, parents));
    return 'picked';
  } catch {
    git('cherry-pick', '--abort');
    git('switch', '-q', '-');
    git('branch', '-D', branch);
    return 'conflict';
  }
}

export function backportOne({ pr, title, sha, target }) {
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
  if (plan === 'skip') return { status: 'skipped' };
  if (cherryPickOnto({ sha, target, branch }) === 'conflict') {
    return { status: 'conflict' };
  }
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

const manual = ({ pr, sha, target }) => {
  const m =
    run('git', ['rev-list', '--parents', '-n', '1', sha]).split(' ').length > 2;
  const branch = backportBranch(pr, target);
  return [
    `- \`${target}\`: \`git fetch origin && git switch -c ${branch} origin/${target} && git cherry-pick -x${m ? ' -m 1' : ''} ${sha}\`, resolve any conflicts, push the branch and open a PR into \`${target}\`.`,
  ].join('\n');
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
  const failed = [];
  for (const target of backportTargets(JSON.parse(values['labels-json']))) {
    const result = backportOne({ pr, title, sha, target });
    console.log(
      `${target}: ${result.status}${result.url ? ` ${result.url}` : ''}`,
    );
    if (result.status === 'conflict' || result.status === 'missing-target') {
      failed.push({ target, status: result.status });
    }
  }
  if (failed.length > 0) {
    const lines = failed.map(
      ({ target, status }) =>
        `${status === 'conflict' ? 'The cherry-pick conflicts' : 'The branch does not exist'} for \`${target}\`.\n${manual({ pr, sha, target })}`,
    );
    run('gh', [
      'pr',
      'comment',
      pr,
      '--body',
      `Could not open every backport automatically.\n\n${lines.join('\n\n')}`,
    ]);
  }
}
