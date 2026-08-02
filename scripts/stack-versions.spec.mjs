import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Keeps docs/STACK.md honest about versions.
 *
 * CLAUDE.md points readers at STACK.md as the pinned-versions reference, and its heading
 * claims the rows are "as installed" — a claim a reader can check and therefore one the
 * repo should not break. It broke repeatedly: the table drifted after four separate
 * dependency waves and was corrected by hand each time, once with the correction itself
 * leaving another row stale.
 *
 * Deliberately narrow. Only rows whose version cell is a single, complete semver are
 * checked; rows that abbreviate on purpose ("4.3 / 1.4", "8 / 6 / 25", "42 / 26", "—") are
 * skipped, because forcing those into exact versions would make the table worse to read.
 * The floor assertion at the bottom is what stops the skip list quietly swallowing
 * everything and leaving a spec that verifies nothing.
 */

const workspaceRoot = join(import.meta.dirname, '..');

const stackDoc = readFileSync(join(workspaceRoot, 'docs/STACK.md'), 'utf8');

/** A row like: | `@angular/core` | 22.1.0 | Standalone + signals … | */
const ROW = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/;
const COMPLETE_SEMVER = /^\d+\.\d+\.\d+$/;

/** Installed version, read off disk so `exports` restrictions cannot hide it. */
const installedVersion = (packageName) => {
  try {
    const manifest = join(
      workspaceRoot,
      'node_modules',
      packageName,
      'package.json',
    );
    return JSON.parse(readFileSync(manifest, 'utf8')).version;
  } catch {
    return null;
  }
};

const checkableRows = stackDoc
  .split('\n')
  .map((line) => line.match(ROW))
  .filter(Boolean)
  .map(([, packageName, documented]) => ({ packageName, documented }))
  .filter(({ documented }) => COMPLETE_SEMVER.test(documented))
  .map((row) => ({ ...row, installed: installedVersion(row.packageName) }))
  .filter(({ installed }) => installed !== null);

describe('docs/STACK.md version table', () => {
  it.each(checkableRows)(
    '$packageName is documented as the version actually installed',
    ({ packageName, documented, installed }) => {
      expect(
        documented,
        `docs/STACK.md lists ${packageName} as ${documented}`,
      ).toBe(installed);
    },
  );

  // Without this the suite passes just as happily when a table rewrite, a formatting
  // change or a stricter regex leaves nothing to check at all.
  it('checks a meaningful number of rows', () => {
    expect(checkableRows.length).toBeGreaterThanOrEqual(10);
  });
});
