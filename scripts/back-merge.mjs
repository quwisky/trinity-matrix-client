/**
 * Opens the PR that merges a stable release branch back into main (see release.yml).
 * Version files that both lines bump are resolved by rule; any other conflict stops the job
 * so a maintainer merges by hand.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const RELEASE_SIDE = new Set([
  'CHANGELOG.md',
  '.release-please-manifest.json',
  'apps/docs-users/release.json',
]);
const MAIN_SIDE = new Set(['package.json', 'electron/package.json']);
const NEXT_MANIFEST = '.release-please-manifest.next.json';
const USER_GUIDE_PAGE = /^apps\/docs-users\/src\/content\/docs\/.+\.mdx?$/;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.(0|[1-9]\d*))?$/;
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function resolutionFor(path) {
  if (RELEASE_SIDE.has(path) || USER_GUIDE_PAGE.test(path)) return 'release';
  if (MAIN_SIDE.has(path)) return 'main';
  if (path === NEXT_MANIFEST) return 'higher';
  return null;
}

const parse = (version) => {
  const match = VERSION.exec(version);
  if (!match)
    throw new Error(`'${version}' is not an X.Y.Z or X.Y.Z-next.N version`);
  const [, major, minor, patch, next] = match;
  return [
    Number(major),
    Number(minor),
    Number(patch),
    next === undefined ? Infinity : Number(next),
  ];
};

export function compareVersions(a, b) {
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

export const higherVersion = (a, b) => (compareVersions(a, b) >= 0 ? a : b);

export function mergeNextManifest(mainText, releaseText) {
  const version = higherVersion(
    JSON.parse(mainText)['.'],
    JSON.parse(releaseText)['.'],
  );
  return `${JSON.stringify({ '.': version }, null, 2)}\n`;
}

export function planBackMerge({ mainContainsTag, existingPr }) {
  if (mainContainsTag) return 'skip';
  return existingPr === null ? 'create' : 'update';
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const succeeds = (command, args) => {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export function resolveConflicts(tag) {
  const conflicted = git('diff', '--name-only', '--diff-filter=U')
    .split('\n')
    .filter(Boolean);
  const unknown = conflicted.filter((path) => resolutionFor(path) === null);
  if (unknown.length > 0) {
    throw new Error(
      `Back-merging ${tag} conflicts outside the version files:\n  ${unknown.join('\n  ')}\n` +
        `Merge ${tag} into main locally, resolve these files, and open the PR by hand. Do not force-push.`,
    );
  }
  for (const path of conflicted) {
    const rule = resolutionFor(path);
    if (rule === 'release') git('checkout', '--theirs', '--', path);
    if (rule === 'main') git('checkout', '--ours', '--', path);
    if (rule === 'higher') {
      writeFileSync(
        path,
        mergeNextManifest(git('show', `:2:${path}`), git('show', `:3:${path}`)),
      );
    }
    git('add', '--', path);
  }
  return conflicted;
}

function run({ tag, branch }) {
  if (!STABLE_TAG.test(tag))
    throw new Error(`'${tag}' is not a stable vX.Y.Z tag`);
  const head = `back-merge/${tag}`;
  git('fetch', '--no-tags', 'origin', 'main', branch);
  git('fetch', 'origin', `refs/tags/${tag}:refs/tags/${tag}`);
  const mainContainsTag = succeeds('git', [
    'merge-base',
    '--is-ancestor',
    tag,
    'origin/main',
  ]);
  const existing = gh(
    'pr',
    'list',
    '--head',
    head,
    '--base',
    'main',
    '--state',
    'open',
    '--json',
    'number',
    '-q',
    '.[0].number',
  );
  const plan = planBackMerge({
    mainContainsTag,
    existingPr: existing ? Number(existing) : null,
  });
  if (plan === 'skip') {
    console.log(`main already contains ${tag}; nothing to back-merge.`);
    return;
  }
  git('switch', '-C', head, 'origin/main');
  let resolved = [];
  if (
    !succeeds('git', [
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      `chore: back-merge ${tag} into main`,
      tag,
    ])
  ) {
    resolved = resolveConflicts(tag);
    git('commit', '--no-edit');
  }
  git('push', '--force-with-lease', 'origin', `${head}:${head}`);
  const body = [
    `Merges \`${branch}\` at \`${tag}\` back into \`main\`: its changelog, version files and any fixes made on the release branch.`,
    '',
    resolved.length > 0
      ? `Conflicts resolved by rule (see \`scripts/back-merge.mjs\`):\n${resolved.map((path) => `- \`${path}\` → ${resolutionFor(path)}`).join('\n')}`
      : 'Merged without conflicts.',
  ].join('\n');
  if (plan === 'update') {
    gh('pr', 'edit', existing, '--body', body);
    console.log(`Updated back-merge PR #${existing}.`);
  } else {
    console.log(
      gh(
        'pr',
        'create',
        '--base',
        'main',
        '--head',
        head,
        '--title',
        `chore: back-merge ${tag} into main`,
        '--body',
        body,
      ),
    );
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { tag: { type: 'string' }, branch: { type: 'string' } },
  });
  run(values);
}
