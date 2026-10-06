/**
 * Prints the version a release/X.Y.x branch's first stable release must take: the newest
 * vX.Y.Z-next.N prerelease in its history, as X.Y.Z. Prints nothing once the line has a
 * stable vX.Y.* tag (later releases are patches) or off a release branch. release.yml
 * passes it to the release-please CLI as --release-as.
 */
import { execFileSync } from 'node:child_process';
import { higherVersion } from './back-merge.mjs';

const BRANCH = /^release\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.x$/;
const TAG =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.(0|[1-9]\d*))?$/;

/** `tags`: the tag names reachable from the branch's head. */
export function firstReleaseVersion(branch, tags) {
  const line = BRANCH.exec(branch);
  if (!line) return '';
  const prereleases = [];
  for (const tag of tags) {
    const match = TAG.exec(tag);
    if (!match || match[1] !== line[1] || match[2] !== line[2]) continue;
    if (match[4] === undefined) return '';
    prereleases.push(tag.slice(1));
  }
  if (prereleases.length === 0) return '';
  return prereleases.reduce(higherVersion).replace(/-next\.\d+$/, '');
}

if (import.meta.main) {
  const tags = execFileSync('git', ['tag', '--merged', 'HEAD'], {
    encoding: 'utf8',
  });
  console.log(firstReleaseVersion(process.argv[2], tags.split('\n')));
}
