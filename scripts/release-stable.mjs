/**
 * Summary for the `Release stable` workflow's promote step: what `develop` adds over the
 * last stable tag, and the version release-please will then propose on `main`
 * (`bump-minor-pre-major: true`, so a breaking change or a feat is a minor bump before 1.0).
 *
 * CLI: node scripts/release-stable.mjs <ref>  (prints Markdown; needs full history and tags)
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RELEASABLE = new Set(['feat', 'fix', 'perf', 'revert']);

export function parseCommit(subject, body = '') {
  const match = /^(\w+)(?:\([^)]*\))?(!)?:/.exec(subject);
  return {
    subject,
    type: match?.[1] ?? null,
    breaking: Boolean(match?.[2]) || /^BREAKING[ -]CHANGE:/m.test(body),
  };
}

export function expectedBump(commits, version) {
  const pre1 = version.startsWith('0.');
  if (commits.some((commit) => commit.breaking))
    return pre1 ? 'minor' : 'major';
  if (commits.some((commit) => commit.type === 'feat')) return 'minor';
  if (commits.some((commit) => RELEASABLE.has(commit.type))) return 'patch';
  return null;
}

export function nextVersion(version, bump) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function lastStableTag(tags) {
  const key = (tag) => tag.slice(1).split('.').map(Number);
  return tags
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    })
    .at(-1);
}

export function summary(tag, commits) {
  const version = tag.slice(1);
  const releasable = commits.filter((commit) => RELEASABLE.has(commit.type));
  const breaking = commits.filter((commit) => commit.breaking);
  const bump = expectedBump(commits, version);
  const list = (items) =>
    items.length ? items.map((c) => `- ${c.subject}`).join('\n') : '- none';
  return [
    `Last stable tag: \`${tag}\``,
    '',
    '### feat, fix, perf and revert commits since then',
    list(releasable),
    '',
    '### Breaking changes',
    list(breaking),
    '',
    bump
      ? `Expected release: \`v${nextVersion(version, bump)}\` (${bump} bump)`
      : 'Expected release: none (no releasable commits)',
  ].join('\n');
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ref = process.argv[2] ?? 'origin/develop';
  const tag = lastStableTag(git('tag', '--list', 'v*').split('\n'));
  if (!tag) throw new Error('No stable vX.Y.Z tag found; fetch tags first.');
  const commits = git(
    'log',
    '--no-merges',
    '--format=%s%x1f%b%x1e',
    `${tag}..${ref}`,
  )
    .split('\x1e')
    .filter((entry) => entry.trim())
    .map((entry) => parseCommit(...entry.trim().split('\x1f')));
  process.stdout.write(`${summary(tag, commits)}\n`);
}
