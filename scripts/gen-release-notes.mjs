// Regenerates apps/trinity/src/app/release-notes.ts: release-please's notes for the app's
// own release line, bundled at build time so devices never fetch them. Without
// TRINITY_RELEASE_NOTES=required it writes an empty list; with it, any failure fails the
// build. Idempotent: it only writes when the content changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'apps/trinity/src/app/release-notes.ts');

// Default release-please headings plus the names configured in release-please-config*.json.
const SECTION_KEYS = {
  Features: 'added',
  Added: 'added',
  'Bug Fixes': 'fixed',
  Fixed: 'fixed',
  'Performance Improvements': 'changed',
  Changed: 'changed',
  Reverts: 'reverted',
  Reverted: 'reverted',
};

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-next\.(\d+))?$/;

/** Cut the PR/commit/closes links (all after the first ` ([`) and the scope prefix, then capitalise. */
function cleanEntry(text) {
  const plain = text
    .replace(/ \(\[.*$/, '')
    .replace(/^\*\*[^*]+:\*\*\s*/, '')
    .trim();
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

/** The user-facing sections of a release-please body; other headings are dropped. */
export function parseReleaseBody(body) {
  const sections = {};
  let key = null;
  let entry = null;
  const flush = () => {
    if (key && entry !== null) {
      const text = cleanEntry(entry);
      if (text) (sections[key] ??= []).push(text);
    }
    entry = null;
  };
  for (const line of body.split(/\r?\n/)) {
    const heading = /^###\s+(.*?)\s*$/.exec(line);
    if (heading) {
      flush();
      key = SECTION_KEYS[heading[1]] ?? null;
    } else if (/^[*-]\s+/.test(line)) {
      flush();
      entry = line.replace(/^[*-]\s+/, '');
    } else if (entry !== null && /^\s+\S/.test(line)) {
      entry += ` ${line.trim()}`;
    } else if (!line.trim()) {
      flush();
    }
  }
  flush();
  return sections;
}

/** `stable` for X.Y.Z, `next` for X.Y.Z-next.N, otherwise null. */
export function releaseLine(version) {
  const match = VERSION.exec(version);
  if (!match) return null;
  return match[4] === undefined ? 'stable' : 'next';
}

/** SemVer order for the accepted forms: a prerelease sorts below its release. */
function compareVersions(a, b) {
  const [pa, pb] = [VERSION.exec(a), VERSION.exec(b)];
  for (let i = 1; i <= 3; i++) {
    if (pa[i] !== pb[i]) return Number(pa[i]) - Number(pb[i]);
  }
  const [na, nb] = [pa[4], pb[4]];
  if (na === undefined || nb === undefined) {
    return (na === undefined) - (nb === undefined);
  }
  return Number(na) - Number(nb);
}

/** The newest `cap` releases on the current version's line, up to the current version. */
export function selectReleases(releases, current, cap = 20) {
  const line = releaseLine(current);
  return releases
    .filter(
      (r) =>
        releaseLine(r.version) === line &&
        compareVersions(r.version, current) <= 0,
    )
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, cap)
    .map((r) => ({
      version: r.version,
      date: r.date,
      sections: parseReleaseBody(r.body ?? ''),
    }));
}

/** Render the release-notes.ts source (pure). */
export function renderReleaseNotes(notes) {
  return `import type { ReleaseNote } from '@trinity/data-access/whats-new';

// Generated (and git-ignored) by scripts/gen-release-notes.mjs. The build/serve targets
// regenerate it via the \`release-notes\` Nx dependency, so it is never committed.
export const RELEASE_NOTES_VALUE: readonly ReleaseNote[] = ${JSON.stringify(notes, null, 2)};
`;
}

/** Resolve the notes to bundle for this build. */
export async function generate(env, fetchImpl = fetch) {
  if (env.TRINITY_RELEASE_NOTES_FIXTURE) {
    return JSON.parse(readFileSync(env.TRINITY_RELEASE_NOTES_FIXTURE, 'utf8'));
  }
  if (env.TRINITY_RELEASE_NOTES !== 'required') return [];

  const current = JSON.parse(
    readFileSync(join(ROOT, 'package.json'), 'utf8'),
  ).version;
  if (!releaseLine(current)) {
    throw new Error(`Cannot bundle release notes for version ${current}`);
  }
  const repository = env.GITHUB_REPOSITORY || 'quwisky/trinity-matrix-client';
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
    { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}` } },
  );
  if (!response.ok) {
    throw new Error(`Fetching release notes failed: HTTP ${response.status}`);
  }
  const releases = (await response.json())
    .filter((r) => !r.draft)
    .map((r) => ({
      version: String(r.tag_name).replace(/^v/, ''),
      date: String(r.published_at).slice(0, 10),
      body: r.body ?? '',
    }))
    .filter((r) => releaseLine(r.version));

  if (env.TRINITY_CURRENT_RELEASE_NOTES) {
    const own = {
      version: current,
      date: new Date().toISOString().slice(0, 10),
      body: env.TRINITY_CURRENT_RELEASE_NOTES,
    };
    releases.splice(
      0,
      releases.length,
      ...releases.filter((r) => r.version !== current),
      own,
    );
  }
  const notes = selectReleases(releases, current);
  if (notes[0]?.version !== current) {
    throw new Error(`No release notes found for version ${current}`);
  }
  return notes;
}

// Run only when invoked directly (not when imported by a test).
if (import.meta.main) {
  const contents = renderReleaseNotes(await generate(process.env));
  let existing = '';
  try {
    existing = readFileSync(OUT, 'utf8');
  } catch {
    // No existing file — write below.
  }
  if (existing !== contents) {
    writeFileSync(OUT, contents);
    console.log('[release-notes] wrote apps/trinity/src/app/release-notes.ts');
  }
}
