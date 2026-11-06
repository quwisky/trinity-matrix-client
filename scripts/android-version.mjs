import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-next\.(\d+))?$/;

/** Encodes a release-please version as an Android versionCode that rises with every release. */
export function androidVersion(semver) {
  const match = VERSION.exec(semver);
  if (!match) {
    throw new Error(
      `Cannot encode "${semver}": expected X.Y.Z or X.Y.Z-next.N`,
    );
  }
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const prerelease = match[4] !== undefined;
  const counter = prerelease ? Number(match[4]) : 99;
  if (
    minor > 99 ||
    patch > 99 ||
    (prerelease && (counter < 1 || counter > 98))
  ) {
    throw new Error(
      `Cannot encode "${semver}": minor and patch must be below 100 and the next counter between 1 and 98`,
    );
  }
  return {
    versionName: semver,
    versionCode: ((major * 100 + minor) * 100 + patch) * 100 + counter,
  };
}

if (import.meta.main) {
  const rootPackage = fileURLToPath(
    new URL('../package.json', import.meta.url),
  );
  const { version } = JSON.parse(readFileSync(rootPackage, 'utf8'));
  process.stdout.write(`${JSON.stringify(androidVersion(version))}\n`);
}
