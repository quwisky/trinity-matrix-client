/**
 * Opens the PR that brings a stable release's metadata back to main (see release.yml) as one
 * commit whose only parent is main; land-back-merge.mjs pushes it to main once CI is green.
 * No release-branch commit enters main's history, so backported fixes are never duplicated there.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const CHANGELOG = 'CHANGELOG.md';
const RELEASE_JSON = 'apps/docs-users/release.json';
const RELEASE_SIDE = new Set([
  CHANGELOG,
  '.release-please-manifest.json',
  RELEASE_JSON,
]);
const NEXT_MANIFEST = '.release-please-manifest.next.json';
const NEXT_CONFIG = 'release-please-config.next.json';
const USER_GUIDE_PAGE = /^apps\/docs-users\/src\/content\/docs\/.+\.mdx?$/;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.(0|[1-9]\d*))?$/;
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function resolutionFor(path) {
  if (RELEASE_SIDE.has(path) || USER_GUIDE_PAGE.test(path)) return 'release';
  if (path === NEXT_MANIFEST) return 'higher';
  if (path === NEXT_CONFIG) return 'anchor';
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

export function planBackMerge({ alreadyBackMerged, existingPr }) {
  if (alreadyBackMerged) return 'skip';
  return existingPr === null ? 'create' : 'update';
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();

/** Leases the bot's own back-merge branch on the sha ls-remote saw; empty when it doesn't exist yet. */
export const leaseFor = (head, lsRemote) =>
  `--force-with-lease=${head}:${lsRemote.split('\t')[0].trim()}`;

const STABLE_MANIFEST = '.release-please-manifest.json';

/** Paths the release line changed since `base` that still differ on `main` and carry a release or higher rule. */
export function metadataPaths(base, main, tag, cwd = process.cwd()) {
  const changed = (from, to) =>
    execFileSync('git', ['diff', '--name-only', '--no-renames', from, to], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    })
      .split('\n')
      .filter(Boolean);
  const differsOnMain = new Set(changed(main, tag));
  return changed(base, tag).filter(
    (path) =>
      differsOnMain.has(path) &&
      ['release', 'higher'].includes(resolutionFor(path)),
  );
}

/** The release line's cut: the nearest prerelease tag behind `tag`, without the `v`. */
export function cutPrerelease(tag, cwd = process.cwd()) {
  let found;
  try {
    found = execFileSync(
      'git',
      ['describe', '--tags', '--abbrev=0', '--match', 'v*-next.*', tag],
      { cwd, encoding: 'utf8', stdio: 'pipe' },
    ).trim();
  } catch (error) {
    throw new Error(
      `No v*-next.* tag is reachable from ${tag}, so its line's cut is unknown: ${`${error.stderr ?? ''}`.trim()}`,
    );
  }
  const version = found.slice(1);
  parse(version);
  return version;
}

const sections = (text) =>
  [...text.matchAll(/^## \[([^\]]+)\].*$/gm)].map((match) => ({
    version: match[1],
    index: match.index,
  }));

/** Adds the release changelog's `## [version]` section to main's, above its first lower version, once. */
export function insertChangelogSection(mainText, releaseText, version) {
  const ours = sections(mainText);
  if (ours.some((section) => section.version === version)) return mainText;
  const theirs = sections(releaseText);
  const i = theirs.findIndex((section) => section.version === version);
  if (i === -1) return mainText;
  const section = `${releaseText.slice(theirs[i].index, theirs[i + 1]?.index).trimEnd()}\n`;
  const below = ours.find(
    (other) =>
      VERSION.test(other.version) &&
      compareVersions(other.version, version) < 0,
  );
  return below
    ? `${mainText.slice(0, below.index)}${section}\n${mainText.slice(below.index)}`
    : `${mainText.trimEnd()}\n\n${section}`;
}

export const isAlreadyBackMerged = ({ changed, mainChangelog, tag }) =>
  !changed ||
  sections(mainChangelog ?? '').some(
    (section) => section.version === tag.slice(1),
  );

/** Writes and stages the release metadata on the checked-out main; commits nothing. */
export function buildBackMerge(tag, cwd = process.cwd()) {
  const at = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  const show = (rev, path) => {
    try {
      return at('show', `${rev}:${path}`);
    } catch {
      return null;
    }
  };
  const write = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
    at('add', '--', path);
  };
  const cut = cutPrerelease(tag, cwd);
  const base = at('merge-base', 'HEAD', tag).trim();
  const version = tag.slice(1);
  const recorded = [
    ...sections(show('HEAD', CHANGELOG) ?? '').map(
      (section) => section.version,
    ),
    JSON.parse(show('HEAD', RELEASE_JSON) ?? '{}').version,
  ];
  // An older line's patch (v0.5.4 after v0.6.0) adds only its changelog section.
  const older = recorded.some(
    (other) =>
      STABLE_TAG.test(`v${other}`) && compareVersions(other, version) > 0,
  );
  const resolved = [];
  for (const path of metadataPaths(base, 'HEAD', tag, cwd)) {
    if (older && path !== CHANGELOG) {
      console.log(
        `Skipping ${path}: main records a release newer than ${tag}.`,
      );
      continue;
    }
    const main = show('HEAD', path);
    const release = show(tag, path);
    if (release === null || (main === null && !RELEASE_SIDE.has(path))) {
      console.log(
        `Skipping ${path}: ${release === null ? `deleted on ${tag}` : 'absent on main'}.`,
      );
      continue;
    }
    write(
      path,
      resolutionFor(path) === 'higher'
        ? mergeNextManifest(main, release)
        : path === CHANGELOG && main !== null
          ? insertChangelogSection(main, release, version)
          : mergeReleaseSide(main, show(base, path), release, at),
    );
    resolved.push(path);
  }
  if (!older) {
    const current = JSON.parse(show('HEAD', STABLE_MANIFEST) ?? '{}')['.'];
    // An older line's patch must not move main's boundary back; a stable value predates cuts.
    const next = current?.includes('-next.')
      ? higherVersion(current, cut)
      : cut;
    write(STABLE_MANIFEST, `${JSON.stringify({ '.': next }, null, 2)}\n`);
    if (!resolved.includes(STABLE_MANIFEST)) resolved.push(STABLE_MANIFEST);
    // When main's next manifest (read from the index) names this stable tag, which is not on
    // main's history, release-please would collect commits far past the cut; stop it there.
    const config = show('HEAD', NEXT_CONFIG);
    if (
      config !== null &&
      JSON.parse(show('', NEXT_MANIFEST) ?? '{}')['.'] === version
    ) {
      const anchor = at('rev-parse', `v${cut}^{commit}`).trim();
      write(
        NEXT_CONFIG,
        `${JSON.stringify({ ...JSON.parse(config), 'last-release-sha': anchor }, null, 2)}\n`,
      );
      resolved.push(NEXT_CONFIG);
    }
  }
  let changed = false;
  try {
    at('diff', '--cached', '--quiet');
  } catch {
    changed = true;
  }
  return { resolved, changed };
}

/** A 3-way merge whose conflicting hunks take the release side; main's other edits stay. */
function mergeReleaseSide(main, base, release, at) {
  if (main === null || base === null) return release;
  const dir = mkdtempSync(join(tmpdir(), 'back-merge-'));
  try {
    for (const [name, content] of Object.entries({ main, base, release })) {
      writeFileSync(join(dir, name), content);
    }
    return at(
      'merge-file',
      '-p',
      '--theirs',
      join(dir, 'main'),
      join(dir, 'base'),
      join(dir, 'release'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run({ tag, branch }) {
  if (!STABLE_TAG.test(tag))
    throw new Error(`'${tag}' is not a stable vX.Y.Z tag`);
  const head = `back-merge/${tag}`;
  git('fetch', '--no-tags', 'origin', 'main', branch);
  git('fetch', 'origin', `refs/tags/${tag}:refs/tags/${tag}`);
  git('switch', '-C', head, 'origin/main');
  const { resolved, changed } = buildBackMerge(tag);
  const alreadyBackMerged = isAlreadyBackMerged({
    changed,
    mainChangelog: git('show', `origin/main:${CHANGELOG}`),
    tag,
  });
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
    alreadyBackMerged,
    existingPr: existing ? Number(existing) : null,
  });
  if (plan === 'skip') {
    console.log(
      `main already carries ${tag}'s release metadata; nothing to back-merge.`,
    );
    return;
  }
  git('commit', '-m', `chore: back-merge ${tag} into main`);
  // Lease on what the remote has now: no local tracking ref for the branch is needed.
  const lease = leaseFor(
    head,
    git('ls-remote', 'origin', `refs/heads/${head}`),
  );
  git('push', lease, 'origin', `${head}:${head}`);
  const body = [
    `Brings the release metadata of \`${branch}\` at \`${tag}\` to \`main\` as one metadata-only commit whose only parent is \`main\`. No release-branch commit enters \`main\`'s history; a fix made only on the release branch needs its own PR to \`main\`.`,
    '',
    `Paths (rules in \`scripts/back-merge.mjs\`; \`CHANGELOG.md\` gains only \`${tag}\`'s section; \`${STABLE_MANIFEST}\` keeps the higher of main's \`-next\` value and the line's cut; \`${NEXT_CONFIG}\` gets \`last-release-sha\` at the cut when main's next manifest takes the stable version):\n${resolved.map((path) => `- \`${path}\``).join('\n')}`,
    '',
    'Lands on `main` as this commit, by a direct push from `scripts/land-back-merge.mjs`, once CI is green on it. Do not merge it with the button.',
  ].join('\n');
  if (plan === 'update') {
    gh('pr', 'edit', existing, '--body', body);
    console.log(`Updated back-merge PR #${existing}.`);
  } else {
    const url = gh(
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
    );
    console.log(url);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { tag: { type: 'string' }, branch: { type: 'string' } },
  });
  run(values);
}
