import type { ReleaseNote } from './release-notes';

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-next\.(\d+))?$/;

function parse(version: string): number[] | null {
  const m = VERSION.exec(version);
  if (!m) return null;
  // A stable release outranks every -next of the same X.Y.Z.
  const next = m[4] === undefined ? Infinity : Number(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), next];
}

/** Negative, zero or positive by SemVer precedence; null when either is unparseable. */
export function compareReleaseVersions(a: string, b: string): number | null {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Notes newer than `lastSeen` and no newer than `running`, newest first. */
export function releasesSince(
  notes: readonly ReleaseNote[],
  lastSeen: string,
  running: string,
): ReleaseNote[] {
  return notes
    .filter(
      (n) =>
        (compareReleaseVersions(n.version, lastSeen) ?? -1) > 0 &&
        (compareReleaseVersions(n.version, running) ?? 1) <= 0,
    )
    .sort((x, y) => compareReleaseVersions(y.version, x.version) ?? 0);
}
