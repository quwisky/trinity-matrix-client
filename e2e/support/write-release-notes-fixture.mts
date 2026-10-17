import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const RELEASE_NOTES_FIXTURE = 'dist/e2e-release-notes.json';

// Written before the build so the newest note always matches package.json's version.
// shortcut: decrements the last numeric part only, so a version ending in 0 has no
// older sibling; upgrade if a release ever ends in `.0` without a `-next.N` suffix.
if (import.meta.main) {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as {
    version: string;
  };
  const older = version.replace(/\d+$/, (n) => String(Number(n) - 1));
  const note = (v: string, text: string) => ({
    version: v,
    date: '2026-01-01',
    sections: { added: [text] },
  });
  mkdirSync(dirname(RELEASE_NOTES_FIXTURE), { recursive: true });
  writeFileSync(
    RELEASE_NOTES_FIXTURE,
    JSON.stringify([
      note(version, 'Newest e2e note'),
      note(older, 'Older e2e note'),
    ]),
  );
}
