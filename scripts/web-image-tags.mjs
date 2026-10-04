/**
 * Image tags for a published release: the exact version always; the moving tags
 * (X.Y and latest for stable, next for prereleases) only for the newest published
 * release on that line, so republishing an older release never moves them back.
 */
import { parseArgs } from 'node:util';

const TAG =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.(0|[1-9]\d*))?$/;

function parse(tag) {
  const match = TAG.exec(tag);
  if (!match) return null;
  const [, major, minor, patch, next] = match;
  return {
    parts: [
      Number(major),
      Number(minor),
      Number(patch),
      next === undefined ? -1 : Number(next),
    ],
    prerelease: next !== undefined,
    version: tag.slice(1),
    minor: `${major}.${minor}`,
  };
}

const newer = (a, b) => {
  for (let i = 0; i < a.parts.length; i += 1)
    if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i];
  return false;
};

export function imageTags(tag, publishedTags) {
  const release = parse(tag);
  if (!release) throw new Error(`Not a release tag: ${tag}`);
  const line = publishedTags
    .map(parse)
    .filter((other) => other && other.prerelease === release.prerelease);
  const tags = [release.version];
  if (release.prerelease) {
    if (!line.some((other) => newer(other, release))) tags.push('next');
    return tags;
  }
  if (
    !line.some(
      (other) => other.minor === release.minor && newer(other, release),
    )
  )
    tags.push(release.minor);
  if (!line.some((other) => newer(other, release))) tags.push('latest');
  return tags;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { tag: { type: 'string' } } });
  if (!values.tag)
    throw new Error('Usage: node scripts/web-image-tags.mjs --tag <vX.Y.Z>');
  const published = (process.env.PUBLISHED_TAGS ?? '')
    .split('\n')
    .filter(Boolean);
  console.log(imageTags(values.tag, published).join('\n'));
}
