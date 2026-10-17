import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const OLDER_VERSION = '0.0.1';
export const RELEASE_NOTES_FIXTURE = 'dist/e2e-release-notes.json';

// Written before the build so the newest note always matches package.json's version.
// The older note is a fixed 0.0.1: the app only compares versions, so it is older on any line.
if (import.meta.main) {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as {
    version: string;
  };
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
      note(OLDER_VERSION, 'Older e2e note'),
    ]),
  );
}
