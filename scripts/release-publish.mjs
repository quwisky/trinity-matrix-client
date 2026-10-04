/**
 * Publishes a draft release once every platform's package is attached (release.yml `publish`).
 * Uses the release App token: a release published with GITHUB_TOKEN would not start the
 * Homebrew, container, docs or apt workflows.
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { compareVersions } from './back-merge.mjs';

export const REQUIRED_ASSETS = Object.freeze([
  /-arm64\.dmg$/,
  /-arm64-mac\.zip$/,
  /\.exe$/,
  /\.AppImage$/,
  /^trinity-desktop_.+_amd64\.deb$/,
  /^Trinity-Web-.+\.zip$/,
]);

export const missingAssets = (names) =>
  REQUIRED_ASSETS.filter(
    (pattern) => !names.some((name) => pattern.test(name)),
  ).map((pattern) => pattern.source);

const STABLE = /^v\d+\.\d+\.\d+$/;

export function shouldBeLatest(tag, publishedStableTags) {
  if (!STABLE.test(tag)) return false;
  return publishedStableTags
    .filter((other) => STABLE.test(other))
    .every((other) => compareVersions(tag.slice(1), other.slice(1)) >= 0);
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();

function run({ tag }) {
  const release = JSON.parse(
    gh('release', 'view', tag, '--json', 'isDraft,isPrerelease,assets'),
  );
  if (!release.isDraft) {
    console.log(`${tag} is already published.`);
    return;
  }
  const missing = missingAssets(release.assets.map(({ name }) => name));
  if (missing.length > 0) {
    console.log(
      `::warning::${tag} stays a draft; missing assets matching: ${missing.join(', ')}. Re-package the tag, then this job publishes it.`,
    );
    return;
  }
  const stable = gh(
    'release',
    'list',
    '--exclude-drafts',
    '--exclude-pre-releases',
    '--limit',
    '1000',
    '--json',
    'tagName',
    '-q',
    '.[].tagName',
  )
    .split('\n')
    .filter(Boolean);
  const latest = !release.isPrerelease && shouldBeLatest(tag, stable);
  gh(
    'release',
    'edit',
    tag,
    '--draft=false',
    `--latest=${latest}`,
    ...(release.isPrerelease ? ['--prerelease'] : []),
  );
  console.log(`Published ${tag}${latest ? ' as latest' : ''}.`);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { tag: { type: 'string' } } });
  run(values);
}
