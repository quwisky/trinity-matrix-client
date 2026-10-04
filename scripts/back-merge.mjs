/**
 * Opens the PR that merges a stable release branch back into main (see release.yml).
 * Version files that both lines bump are resolved by rule; any other conflict stops the job
 * so a maintainer merges by hand.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const RELEASE_SIDE = new Set([
  'CHANGELOG.md',
  '.release-please-manifest.json',
  'apps/docs-users/release.json',
]);
const MAIN_SIDE = new Set(['package.json', 'electron/package.json']);
const NEXT_MANIFEST = '.release-please-manifest.next.json';
const STABLE_CONFIG = 'release-please-config.json';
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

/** Release stable's one-time pin belongs to the release branch only; main never keeps it. */
export function withoutReleaseAs(configText) {
  const config = JSON.parse(configText);
  if (!Object.hasOwn(config.packages['.'], 'release-as')) return null;
  delete config.packages['.']['release-as'];
  return `${JSON.stringify(config, null, 2)}\n`;
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

export function resolveConflicts(tag, cwd = process.cwd()) {
  const at = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const stage = (n, path) => {
    try {
      return at('show', `:${n}:${path}`);
    } catch {
      return null;
    }
  };
  const conflicted = at('diff', '--name-only', '--diff-filter=U')
    .split('\n')
    .filter(Boolean);
  const unknown = conflicted.filter((path) => resolutionFor(path) === null);
  if (unknown.length > 0) {
    throw new Error(
      `Back-merging ${tag} conflicts outside the version files:\n  ${unknown.join('\n  ')}\n` +
        `Merge ${tag} into main locally, resolve these files, and open the PR by hand. Do not force-push.`,
    );
  }
  const resolved = [];
  for (const path of conflicted) {
    const rule = resolutionFor(path);
    const main = stage(2, path);
    const release = stage(3, path);
    const base = stage(1, path);
    let text;
    let wholeFile = false;
    if (rule === 'higher') {
      text = mergeNextManifest(main, release);
    } else if (base === null) {
      // Added on both lines: no common ancestor to merge hunks against.
      text = rule === 'release' ? release : main;
      wholeFile = true;
    } else {
      // Per hunk: only the conflicting hunks take the rule's side; other edits on either side stay.
      const dir = mkdtempSync(join(tmpdir(), 'back-merge-'));
      try {
        const files = { main, base, release };
        for (const [name, content] of Object.entries(files)) {
          writeFileSync(join(dir, name), content);
        }
        text = at(
          'merge-file',
          '-p',
          rule === 'release' ? '--theirs' : '--ours',
          join(dir, 'main'),
          join(dir, 'base'),
          join(dir, 'release'),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    writeFileSync(join(cwd, path), text);
    at('add', '--', path);
    resolved.push({ path, rule, wholeFile });
  }
  return resolved;
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
      '--no-commit',
      '-m',
      `chore: back-merge ${tag} into main`,
      tag,
    ])
  ) {
    resolved = resolveConflicts(tag);
  }
  const config = withoutReleaseAs(readFileSync(STABLE_CONFIG, 'utf8'));
  if (config !== null) {
    writeFileSync(STABLE_CONFIG, config);
    git('add', '--', STABLE_CONFIG);
  }
  git('commit', '--no-edit');
  git('push', '--force-with-lease', 'origin', `${head}:${head}`);
  const body = [
    `Merges \`${branch}\` at \`${tag}\` back into \`main\`: its changelog, version files and any fixes made on the release branch.`,
    '',
    resolved.length > 0
      ? `Conflicting hunks resolved by rule (see \`scripts/back-merge.mjs\`):\n${resolved.map(({ path, rule, wholeFile }) => `- \`${path}\` → ${rule}${wholeFile ? ' (whole file: added on both lines, review it)' : ''}`).join('\n')}`
      : 'Merged without conflicts.',
    ...(config === null
      ? []
      : [
          '',
          `Drops the one-time \`release-as\` that \`${STABLE_CONFIG}\` carries on the release branch.`,
        ]),
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
